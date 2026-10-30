---
title: Kysely
description: Kysely標準のクエリ・更新結果・対話型トランザクションをPolicySQL経由で利用します。
---

# Kysely

PolicySQL の Dialect を設定すると、Kysely 標準のクエリとトランザクションを、PolicySQL の認可・検証を通して実行できます。対応する Kysely は **0.29.5** です。Node.js は 22 以上が必要で、CI は Node.js 24 で検証します。

## 接続する

```ts
import { Kysely } from 'kysely'
import { PolicySqlClient, createHttpTransport } from '@unacowa/policysql/client'
import { PolicySqlDialect, policyOptions } from '@unacowa/policysql/kysely'

interface Database {
  posts: {
    id: string
    title: string
    status: 'draft' | 'published'
  }
}

const transport = createHttpTransport({
  endpoint,
  fetchImpl: async (url, init) => {
    const token = await getAccessToken() // アプリケーション側で取得・更新する
    init?.signal?.throwIfAborted() // 非同期準備中の中断を遅延送信につなげない
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  },
})
const client = new PolicySqlClient({ transport })
const db = new Kysely<Database>({
  dialect: new PolicySqlDialect({ client }),
})
```

認証方式と資格情報の取得・更新はアプリケーションが管理します。HTTP helper は認証ヘッダーを自動付与しません。DB の接続情報は gateway 側の wrapper が管理します。

`PolicySqlTransport` は `(request, { signal }?) => Promise<{ status, body }>` の関数です。公開 request の `kind`、固定済み JSON 文字列 `body`、任意の `role`、実行キーまたは transaction ID を受け取ります。独自 Transport や単純な委譲 wrapper も使えます。各呼び出しで最大1回送信し、本文を保持して、キャンセルを尊重してください。

`createHttpTransport` は固定 route、HTTPS（開発用 localhost は HTTP 可）、redirect 拒否、`credentials: 'omit'` を提供し、応答を標準の `response.json()` で読み取ります。追加の通信サイズ制限は利用者の Transport で実装します。正常に読めた4xx／5xxも `{ status, body }` として返し、fetch・本文読取り・JSON parse の例外はそのまま伝えます。`fetchImpl` 省略時は標準 fetch を使います。

`role` を省略すると、gateway が検証した JWT の `default_role` を使います。別の許可済みロールを選ぶ場合や、想定する schema / policy と一致するときだけ実行したい場合は、追加のオプションを指定します。

```ts
const client = new PolicySqlClient({
  transport,
  role: 'author',
  schemaVersion: 'schema_17',
  policyVersion: 'policy_42',
})
```

`role` とバージョン条件は独立して省略できます。`schemaVersion` と `policyVersion` は **両方指定するか、両方省略**します。片方だけの指定、空文字、`null`、不正な型は送信前にエラーになります。

Client の role・schemaVersion・policyVersion・Transport 参照は構築時に固定され、元の options の変更やプロパティ代入では変更できません。別の構成には別の Client を作ります。HTTP helper の endpoint・fetchImpl 参照も固定です。独自関数の内部でも利用中の論理的な接続先・DB を切り替えないでください。資格情報の更新は可能ですが、同一 command の再確認には元の認証・DB context が必要です。

通信タイマーはありません。直接の Client 呼び出しでは `signal: AbortSignal.timeout(1000)` などを指定できます。`execute`、`beginTransaction`、transaction の `execute`／`commit`／`rollback`／`retryPending` が signal を受け取ります。Kysely からの通信期限は注入した fetchImpl／Transport で設定し、渡されたキャンセル signal と合成してください。signal を無視する実装の終了時間は保証しません。

バージョン条件を省略すると、現在の schema / policy で検証・認可・実行します。指定して不一致だった場合は `POLICYSQL_STALE_OPERATION` で拒否し、条件を外して再送しません。Catalog の自動取得は行いません。

## 検索・更新する

```ts
const posts = await db.selectFrom('posts')
  .select(['id', 'title'])
  .where('status', '=', 'published')
  .execute()

const result = await db.updateTable('posts')
  .set({ title: 'Updated title' })
  .where('id', '=', 'post_01')
  .executeTakeFirstOrThrow()

result.numUpdatedRows // bigint
```

INSERT / UPDATE / DELETE で RETURNING を指定しない場合は、Kysely 標準の `InsertResult` / `UpdateResult` / `DeleteResult` を返します。更新後の値や生成された ID が必要なら `returning()` を使用します。`insertId` は提供しません。

```ts
const post = await db.insertInto('posts')
  .values({ id: 'post_02', title: 'New post', status: 'draft' })
  .returning(['id', 'title'])
  .executeTakeFirstOrThrow()
```

通常の `.execute()`、`.executeTakeFirst()`、`.executeTakeFirstOrThrow()` をそのまま使えます。Kysely の型は認可を保証せず、gateway が毎回 SQL を検証します。

## 成功する件数を指定する

`expect` を付けると、PolicySQL が commit 前に件数を検証します。条件を満たさない場合は rollback します。

```ts
await db.updateTable('posts')
  .set({ status: 'published' })
  .where('id', '=', 'post_01')
  .withPlugin(policyOptions({ expect: { affectedRows: 1 } }))
  .execute()
```

`affectedRows` は更新件数、`rowCount` は SELECT / RETURNING の行数です。非対話型の更新が返った後にアプリケーションで件数を検査しても、既に行われた commit は取り消せません。

## 対話型トランザクション

先行クエリの結果を使い、次の処理を決められます。

```ts
const postId = await db.transaction().execute(async (trx) => {
  const post = await trx.selectFrom('posts')
    .select(['id', 'status'])
    .where('id', '=', 'post_01')
    .executeTakeFirstOrThrow()

  if (post.status !== 'draft') throw new Error('Post must be a draft')

  await trx.updateTable('posts')
    .set({ status: 'published' })
    .where('id', '=', post.id)
    .withPlugin(policyOptions({ expect: { affectedRows: 1 } }))
    .execute()

  return post.id
})
```

callback の正常終了後に commit し、その成功を確認してから戻り値を返します。処理中に例外を投げると rollback します。callback 全体を自動で再実行しません。

commit / rollback を自分で管理する形式にも対応します。

```ts
const trx = await db.startTransaction().setAccessMode('read only').execute()
const posts = await trx.selectFrom('posts').select(['id', 'title']).execute()
await trx.commit().execute()
// 破棄する場合は commit の代わりに await trx.rollback().execute()
```

既定は write transaction です。read-only transaction の更新は Server が実行前に拒否し、`POLICYSQL_TRANSACTION_MODE_VIOLATION` を返して transaction を終了します。server 上限は deployment の設定で決まり、Capabilities の `transactions.maxInteractiveDurationMs`、`maxStatements`、`maxResultBytes` が実際に強制される値を示します。既定は **4 秒、8 statements、累積結果 64,000 bytes** です。期限にはアプリケーションの待機と commit checks の時間も含みます。

対話型では、利用 DB に `policysql_idempotency` テーブルは不要です。開始キーを指定する補助 API はなく、開始時のキー自動生成も行いません。transaction 内のクエリに `idempotencyKey` を付けると送信前エラーになります。`expect` は利用できます。

begin を含め自動再送はありません。開始応答を受け取れなければ結果不明を返し、callback を開始しません。利用者が新しい begin を呼ぶと別の transaction が作られ得ます。取り残された空の transaction は server の期限処理に従います。

Client の `expiresAt` は server の期限情報です。Client はローカル時刻で要求を拒否したり、rollback 済みと判定したりしません。Server が実際の期限と状態を管理します。

## 同じ atomic 更新を再送する

transaction 外の更新には、任意の `idempotencyKey` を付けられます。同じ業務操作を再送するときは、キーと更新内容を保持してください。

```ts
const idempotencyKey = crypto.randomUUID()
const operation = db.updateTable('posts')
  .set({ title: 'Updated title' })
  .where('id', '=', 'post_01')
  .withPlugin(policyOptions({ idempotencyKey }))

await operation.execute()

// 応答を受け取れなかった場合の再送ボタン等から呼ぶ
async function retry() {
  return operation.execute()
}
```

キー付き atomic 更新では、利用 DB に `policysql_idempotency` を事前作成します。同じ認証 context・endpoint・DB binding・payload と、保持中の記録を使う前提です。キーの形式は 16〜128 文字の ASCII 英数字と `. _ : - + / =` です（base64 のキーをそのまま使えます）。形式不正のキーはサーバーが `POLICYSQL_IDEMPOTENCY_KEY_INVALID`（400）で拒否します。不正な明示キーを省略や自動生成で補いません。

| 設定 | 操作ごとのキー | 動作 |
| --- | --- | --- |
| 既定 / `autoIdempotencyKey: false` | 省略 | キーなし。冪等性テーブル不要 |
| `autoIdempotencyKey: true` | 省略 | atomic 更新の実行ごとに新規生成 |
| どちらでも | 明示 | 指定したキーを送信 |

```ts
const db = new Kysely<Database>({
  dialect: new PolicySqlDialect({ client, autoIdempotencyKey: true }),
})
```

自動生成時は `crypto.randomUUID()` が必要です。同じ builder を再実行しても別キーになるため、業務操作の再送には明示キーを使います。SELECT と対話型 transaction には自動付与しません。atomic 更新の通信再試行は自動で行いません。

## 結果の metadata と plugin

```ts
const posts = await db.selectFrom('posts')
  .select(['id', 'title'])
  .withPlugin(policyOptions({
    onResponse(response) {
      console.log(response.rows, response.meta)
    },
  }))
  .execute()
```

`onResponse` は同じ gateway 応答の rows と metadata のコピーを受け取ります。通常の `.execute()` の戻り値は Kysely 標準のままです。`meta.result.columns` は結果型、`meta.result.redactions` はポリシーで伏せられたセルを表します。`NullableOnDenied<T>` は `T | null` の型ヒントとして引き続き使えます。

`CamelCasePlugin` などの `transformQuery` / `transformResult` に対応します。`policyOptions` は、そのクエリの **最後の plugin** として、実行する root query に付けてください。subquery への設定や重複付与は未対応です。

通常の AST コピー・変換による順序不正と、設定の重複・破損は送信前に検出します。ただし、後続の自作 plugin が AST 全体を独立した別の tree に置き換えて設定を消す場合、標準 Dialect から完全には検出できません。自作の query plugin も必ず `policyOptions` より前に設定してください。

`CompiledQuery` は `query` を保持した浅いコピーでも設定を維持します。パラメーターはClientへの要求送信時に固定されるため、同じ操作の再送に使うキーと値はアプリケーションで保持してください。

metadata は結果変換前の rows に対応します。列名変更や行の並べ替え後の結果へ、元の redaction index / 列名をそのまま適用しないでください。observer が例外を投げても、commit 済みの atomic 更新は取り消されません。

`onResponse` が返す Promise は通常どおり完了まで待ちます。独自 timeout はなく、callback／結果 plugin の例外をそのまま伝えます。同じ transaction の次の SQL は `onResponse` 内で待たず、外側のクエリを `await` した後に実行してください。Kysely は observer が返るまでその connection を使用中として扱います。

## エラーと終了処理

`PolicySqlError` は `code`、`status` と検証した公開応答 `response` を保持します。サーバーの message・path・requestId を独自の固定文言に置き換えません。Transport 呼び出し後の通信断・不正応答などで実行結果を確定できない場合は `PolicySqlOutcomeUnknownError` を返し、元例外を `cause` に保持します。既知の code／status と構造を検証できた拒否は通常の公開エラーとして伝えます。未知のエラーや汎用5xxは未実行の証明にしません。

Transport 呼び出し前の中断では元の `AbortSignal.reason` を返します。利用者 callback／注入関数の例外にはアプリケーションの情報が含まれ得ます。ログ出力や外部への公開方針はアプリケーションが管理します。

```ts
import { PolicySqlOutcomeUnknownError } from '@unacowa/policysql/client'

try {
  await operation.execute()
} catch (error) {
  if (error instanceof PolicySqlOutcomeUnknownError) {
    console.log(error.phase, error.transactionId, error.sequence)
  }
  throw error
}
```

対話型も各呼び出しは1回だけ送信します。明示的な再確認には低レベル transaction の `retryPending()`、または pending と同じ `commit()`／`rollback()` を使います。同じ transaction ID・sequence・role・本文を保持します。後続の認証拒否やキャンセルで元の結果不明を解除せず、元の `cause` と最新の確認失敗 `lastError` を保持します。commit の結果が不明な場合に、別 transaction で callback を実行し直したり、反対の rollback を送ったりしません。controlled transaction では同じ `trx.commit().execute()` で pending commit を再確認できます。

利用終了時は `await db.destroy()` で資源を解放します。controlled transaction の終了操作は利用者が管理してください。期限や結果不明のため閉じられない remote transaction は server の期限処理に従います。

`destroy()` は新しい処理の受付を停止し、その Driver の進行中の処理へキャンセルを通知します。共有 Transport や外部資源は終了しません。安全に終了できる transaction は rollback します。全接続の後始末を待ち、新たに行ったrollback等が失敗した場合は元のエラー、複数失敗した場合は各エラーを保持する `AggregateError` を返します。クエリの内部解放では検証済みの結果や元の実行エラーを上書きしません。明示的な rollback や callback 失敗後の rollback 自体が失敗した場合は、そのエラーを伝えます。送信済み commit と重なっても、検証できた応答は成功として返します。結果不明なら `POLICYSQL_OUTCOME_UNKNOWN` と `phase`・`transactionId`・`sequence` を保持し、rollback 要求は送りません。`destroy()` の完了は commit 成功や rollback 完了の保証ではないため、transaction の Promise も必ず確認してください。

## 対応範囲

利用できる SQL は [SELECT](../sql/select)・[更新 SQL](../sql/mutations) と各ポリシーで制限されます。明示的な isolation level、savepoint、nested transaction、stream、schema / migration / DB introspection、トップレベル raw statement は未対応です。query 内の SQL 式も gateway の検証対象です。バッチ実行には既存の HTTP Atomic Execute を使用します。
