---
title: Transport
description: HTTP と Worker の通信を差し替え、JWT を client から分離します。
---

# Transport

`PolicySqlClient` は `transport` を必須とします。client は SQL 要求・応答検証・transaction の順序と結果不明を管理し、transport は認証と実通信を担当します。Kysely のクエリや transaction API は通信方式によって変わりません。

## HTTP

```ts
import { PolicySqlClient } from '@unacowa/policysql/client'
import { createHttpTransport } from '@unacowa/policysql/transport/http'

const transport = createHttpTransport({ endpoint, token, timeoutMs: 15_000 })
const client = new PolicySqlClient({ transport })
```

`endpoint / token / tokenProvider / fetchImpl / timeoutMs` は transport 側の設定です。client が transport を省略して HTTP を使う fallback はありません。HTTP 接続は HTTPS（開発用 localhost だけ HTTP）、redirect を拒否し、業務要求に Cookie を付与しません。要求本文は 1 MiB、HTTP 応答本文は 2 MiB までです。

JWT を更新する場合は、固定 `token` の代わりに利用者の `tokenProvider` を指定します。

```ts
import type { TokenProvider } from '@unacowa/policysql/transport/http'

const tokenProvider: TokenProvider = {
  async getToken({ minValidityMs, signal }) {
    // 利用者の認証処理。必要な残存時間の JWT を取得する。
    return obtainCredential({ minValidityMs, signal })
    // 戻り値: { token, expiresAt: Unix epoch milliseconds }
  },
}
const transport = createHttpTransport({ endpoint, tokenProvider })
```

provider は送信のたびに呼ばれ、その時点で返した JWT を使います。ライブラリは JWT をキャッシュせず、並行する取得処理も共有しません。キャッシュ・取得処理の共有・ログイン切替時の要求停止は利用者の認証処理で管理します。client／port をログイン状態に固定する機能はありません。開始済み transaction の認証・DB binding・snapshot の同一性は server が検証します。

begin の前には、transaction の最大時間・残り通信予算・時計差の余裕を満たす JWT を準備します。`transactionMaxDurationMs` の既定値は現在の server profile に合わせて 4,000 ms、`clockToleranceMs` は 5,000 ms です。これは準備用の値であり、開始後は server の `expiresAt` を使います。JWT の decode は期限確認のためで、署名検証や認可を代行しません。

一要求のキャンセルは、その取得処理に渡した signal に通知します。別要求の signal は中断しません。provider の失敗は安全な認証エラーとなり、JWT・例外の message／stack／cause は client に渡しません。

HTTP の `timeoutMs` は 1 回の送信ごとの上限で、JWT 取得・fetch・応答読取りを含みます。既定値は 15 秒です。自動再送にも毎回同じ上限を適用し、再送間で予算を共有しません。server の transaction 期限は延長しません。

## Dedicated Worker

UI 側は `MessagePort` を transport に渡します。JWT の取得・保持・付与は Worker 側で行います。

```ts
// UI
import { Kysely } from 'kysely'
import { PolicySqlClient } from '@unacowa/policysql/client'
import { PolicySqlDialect } from '@unacowa/policysql/kysely'
import { createAuthAgentTransport } from '@unacowa/policysql/transport/auth-agent'

const worker = new Worker(new URL('./transport.worker.ts', import.meta.url), { type: 'module' })
const { port1, port2 } = new MessageChannel()
worker.postMessage({ type: 'connect', port: port2 }, [port2])
const transport = await createAuthAgentTransport(port1)
const db = new Kysely<Database>({
  dialect: new PolicySqlDialect({ client: new PolicySqlClient({ transport }) }),
})

const projects = await db.selectFrom('projects').select(['id', 'name']).execute()
```

```ts
// transport.worker.ts
import { createHttpTransport } from '@unacowa/policysql/transport/http'
import { serveAuthAgentTransport } from '@unacowa/policysql/transport/auth-agent'
import { endpoint, tokenProvider } from './application-auth.js'

const http = createHttpTransport({ endpoint, tokenProvider })
self.addEventListener('message', event => {
  if (event.data?.type === 'connect' && event.data.port instanceof MessagePort) {
    serveAuthAgentTransport(event.data.port, http)
  }
})
```

`application-auth.js`、Worker の作成と破棄、port の相手確認は利用者が実装します。別 origin の window を介して port を渡す場合、その bootstrap で origin/source を確認します。ライブラリは認証 UI・認証 API・Worker 配置を決定しません。

bridge は初期 handshake で接続先 descriptor を受け取ります。認証情報は Worker 側の provider が送信ごとに決定します。JWT を取得する RPC や、任意 URL・認証 header を送る RPC はありません。

`createAuthAgentTransport` の初期化待ちは最大 15 秒です。送信ごとの待機上限は `createAuthAgentTransport(port, { timeoutMs })` で設定でき、既定値は 15 秒です。HTTP 側の `timeoutMs` とは独立した設定で、先に到達する上限で終了します。今回の送信の期限とキャンセルは Worker に伝わり、次の試行には新しい期限を設定します。切断を検出できない場合も待機は期限で終了します。送信後のキャンセルや切断は未実行の証明にはなりません。

## 再送・再確認

同一の自動試行系列は同じ command を使い、各送信は独立した timeout を持ちます。client の自動試行は最大 2 回で、HTTP transport は独自のネットワーク再送や 401 後の暗黙再送を行いません。atomic execute は自動再送しません。

`retryPending()` や pending commit の再呼び出しでも、保存した command ID・transaction ID・sequence・payload・元の結果不明を引き継ぎます。statement は server の期限内だけ再確認し、期限後は送信せず元の結果不明を返します。送信済み terminal command は期限後も保存応答を確認できます。

再確認には元の要求と同じ認証・DB が必要です。ユーザーを切り替えた場合、開始済み transaction の操作は server が拒否します。atomic の idempotency key は認証情報ごとに区別されるため、別ユーザーで同じキーを送っても以前の更新の再確認にはなりません。

callback 全体を再実行せず、新しい transaction へ更新を移して再送しません。

## 終了処理

`db.destroy()` はその Driver の処理を終了し、共有 transport 全体を終了しません。所有者がすべての client の利用終了後に `transport.dispose()` を呼びます。Worker 側の `serveAuthAgentTransport(...).dispose()` はその port の scope だけを解放し、共有 HTTP transport を終了しません。

client 内部の operation／scope 解放エラーは、成功結果や元の実行エラーを置き換えません。解放処理の例外は DB の rollback を意味しません。commit／rollback 本体の失敗は通常どおり扱います。

## 独自 transport

公開型は `@unacowa/policysql/transport` にあります。

- `createScope({ role? })` は role と通信資源をまとめるローカル handle を作ります。認証 context は固定しません。
- `scope.createOperation(command, options)` は不変 command の試行系列を作ります。
- `operation.send({ signal? })` は `{ type: 'response', status, body }` または `{ type: 'failure', code, delivery }` を返します。
- `delivery` は今回の試行の `not-sent`／`possibly-sent` です。前回の未確認結果を消しません。
- `scope.beginShutdown()` は通常の新規操作と未送信操作を停止します。送信済み command の確認と安全な cleanup rollback は区別します。
- `dispose()` は通信資源の解放です。SQL rollback を独自に送信しません。

独自 transport は各送信を有限時間で完了し、server の期限と signal を守る必要があります。client は通信待ち用の外側のタイマーを追加しません。応答しない独自 transport まで client 単体で終了させる保証はありません。
