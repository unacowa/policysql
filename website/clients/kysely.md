---
title: Kysely
description: Kysely標準のクエリ・更新結果・対話型トランザクションをPolicySQL経由で利用します。
---

# Kysely

PolicySQL の Dialect を設定すると、Kysely 標準のクエリとトランザクションを、PolicySQL の認可・検証を通して実行できます。対応する Kysely は **0.29.5** です。Node.js は 22 以上が必要で、CI は Node.js 24 で検証します。

## 接続する

```ts
import { Kysely } from 'kysely'
import { PolicySqlClient } from '@unacowa/policysql/client'
import { PolicySqlDialect, policyOptions } from '@unacowa/policysql/kysely'
import { createHttpTransport } from '@unacowa/policysql/transport/http'

interface Database {
  posts: {
    id: string
    title: string
    status: 'draft' | 'published'
  }
}

const transport = createHttpTransport({ endpoint, token })
const client = new PolicySqlClient({ transport })
const db = new Kysely<Database>({
  dialect: new PolicySqlDialect({ client }),
})
```

`endpoint` と `token` は HTTP transport に渡します。client の通信経路は必須の `transport` だけです。DB の接続情報は gateway 側の wrapper が管理します。クライアントに Turso の認証情報を渡しません。

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

バージョン条件を省略すると、現在の schema / policy で検証・認可・実行します。指定して不一致だった場合は `POLICYSQL_STALE_OPERATION` で拒否し、条件を外して再送しません。Catalog の自動取得は行いません。

## 通信と JWT を分離する

HTTP transport の `timeoutMs` は、1 回の送信における認証待ち・fetch・応答読取りの上限です。自動再送にも毎回この上限を適用します。server の transaction 寿命を延ばす設定ではありません。`fetchImpl` も transport 側で指定します。

```ts
const transport = createHttpTransport({ endpoint, token, timeoutMs: 15_000 })
```

固定 JWT の代わりに `tokenProvider` を渡すと、送信ごとに必要な残存時間を持つ JWT を取得できます。JWT の署名と認可は server が検証します。ログイン切替時の client／port の扱いは利用者が決めます。ライブラリは認証 context を固定せず、JWT のキャッシュや取得処理の共有も行いません。provider の取得失敗での自動再送や、401 後の暗黙再送は行いません。

UI でクエリを作り、Dedicated Worker で JWT の取得・付与と HTTP を行う構成にも対応します。[transport の契約と Worker の接続例](./transport)を参照してください。

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

既定は write transaction です。read-only transaction で更新はできません。現在の server 上限は **4 秒、8 statements、累積結果 64,000 bytes** です。アプリケーションの待機と commit checks の時間も含みます。

対話型では、利用 DB に `policysql_idempotency` テーブルは不要です。開始キーを指定する補助 API はなく、開始時のキー自動生成も行いません。transaction 内のクエリに `idempotencyKey` を付けると送信前エラーになります。`expect` は利用できます。

開始応答を受け取れず SQL が未実行の場合、開始要求のみを最大 2 回試行します。HTTP transport の既定 timeout は 1 回につき 15 秒で、JWT の準備時間も含みます。取り残された空の transaction は server の期限処理で閉じます。開始後は同じ transaction ID と sequence によって command を再送します。

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

キー付き atomic 更新では、利用 DB に `policysql_idempotency` を事前作成します。同じ認証 context・endpoint・DB binding・payload と、保持中の記録を使う前提です。キーの形式は 16〜128 文字の英数字と `._:-` です。不正な明示キーを省略や自動生成で補いません。

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

metadata は結果変換前の rows に対応します。列名変更や行の並べ替え後の結果へ、元の redaction index / 列名をそのまま適用しないでください。observer が例外を投げても、commit 済みの atomic 更新は取り消されません。

`onResponse` の待機上限は対話型では transaction の残り時間、atomic では応答受信から 5 秒です。超過時は `POLICYSQL_OBSERVER_TIMEOUT` または transaction 期限切れのエラーになります。同じ transaction の次の SQL は `onResponse` 内で待たず、外側のクエリを `await` した後に実行してください。Kysely は observer が返るまでその connection を使用中として扱います。

## エラーと終了処理

`PolicySqlError` の `code` と、HTTP エラーの場合の `status` を確認できます。通信断や不正応答で実行結果を確定できない場合は `PolicySqlOutcomeUnknownError` を返します。

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

対話型の command 自動再送は一つの呼び出しにつき最大 2 回です。各試行には独立した timeout を適用します。statement は server の `expiresAt` 以内で試行します。送信済みの commit／rollback は、transaction の期限後も同じ command で保存応答を確認できます。commit の結果が不明な場合に、別 transaction で callback を実行し直したり、反対の rollback を送ったりしません。controlled transaction では同じ `trx.commit().execute()` で pending commit を再確認できます。

利用終了時は `await db.destroy()` で、その Driver が所有する処理を終了します。共有 transport 全体は終了しないため、アプリケーションの所有者が最後に `await transport.dispose()` を呼びます。controlled transaction の終了操作は利用者が管理してください。期限や結果不明のため閉じられない remote transaction は server の期限処理に従います。

`destroy()` は新しい処理の受付を停止します。送信済みの commit と重なった場合は、既定の時間・回数の範囲でその結果を確認し、transaction の Promise に成功または元のエラーを返します。結果不明なら `POLICYSQL_OUTCOME_UNKNOWN` と `phase`・`transactionId`・`sequence` を保持し、rollback 要求は送りません。`destroy()` の完了は commit 成功や rollback 完了の保証ではないため、transaction の Promise も必ず確認してください。

低レベル client の `transaction.retryPending()` は、保存された statement／commit／rollback を再確認します。transaction ID・command ID・sequence・payload と過去の結果不明は維持します。再確認には元と同じ認証・DB が必要で、その一致は server が検証します。statement の期限後は送信せず、元の結果不明を返します。通常の Kysely 利用にこの呼び出しは必要ありません。

client 内部の transport operation／scope の解放失敗は、検証済みの成功・確定したエラー・元の結果不明を上書きしません。DB の commit／rollback 本体や利用者の observer の例外は別途処理します。

## 対応範囲

利用できる SQL は [SELECT](../sql/select)・[更新 SQL](../sql/mutations) と各ポリシーで制限されます。明示的な isolation level、savepoint、nested transaction、stream、schema / migration / DB introspection、トップレベル raw statement は未対応です。query 内の SQL 式も gateway の検証対象です。バッチ実行には既存の HTTP Atomic Execute を使用します。
