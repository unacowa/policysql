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
  currentContextKey: () => sessionGeneration,
  async getToken({ contextKey, minValidityMs, signal }) {
    // 利用者の認証処理。必要な残存時間の JWT を取得する。
    return obtainCredential({ contextKey, minValidityMs, signal })
    // 戻り値: { token, expiresAt: Unix epoch milliseconds, contextKey }
  },
}
const transport = createHttpTransport({ endpoint, tokenProvider })
```

`contextKey` は同じ認証 context の更新では維持し、logout・ユーザー／tenant／session の切替では変更する非秘密の世代 ID です。使用可能文字は英数字と `_.:-`、長さは 1〜128 です。server 内部の DB binding や snapshot は server が検証します。

begin の前には、transaction の最大時間・残り通信予算・時計差の余裕を満たす JWT を準備します。`transactionMaxDurationMs` の既定値は現在の server profile に合わせて 4,000 ms、`clockToleranceMs` は 5,000 ms です。これは準備用の値であり、開始後は server の `expiresAt` を使います。JWT の decode は期限確認のためで、署名検証や認可を代行しません。

同じ context の更新待ちは共有します。一要求のキャンセルで別要求の更新を取り消しません。provider の失敗は安全な認証エラーとなり、JWT・例外の message／stack／cause は client に渡しません。

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

bridge は初期 handshake を行い、接続先 descriptor と認証 context の世代を固定します。接続先変更や別 context への自動切替を行いません。JWT を取得する RPC や、任意 URL・認証 header を送る RPC はありません。

`createAuthAgentTransport` の初期化待ちは最大 15 秒です。その後の operation は Worker 側の通信予算を使い、port 待ち・認証・HTTP・再送に同じ期限を適用します。切断を検出できない場合も期限で終了します。送信後のキャンセルや切断は未実行の証明にはなりません。

## 再送・再確認

同一の自動試行系列は同じ operation を使います。client の自動試行は最大 2 回で、HTTP transport は独自のネットワーク再送や 401 後の暗黙再送を行いません。atomic execute は自動再送しません。

`retryPending()` や pending commit の再呼び出しは、新しい有限 operation を作ります。保存した command ID・transaction ID・sequence・payload・context・元の結果不明は引き継ぎます。statement は server の期限内だけ再確認し、期限後は送信せず元の結果不明を返します。送信済み terminal command は期限後も保存応答を確認できます。

callback 全体を再実行せず、新しい transaction へ更新を移して再送しません。

## 終了処理

`db.destroy()` はその Driver の処理を終了し、共有 transport 全体を終了しません。所有者がすべての client の利用終了後に `transport.dispose()` を呼びます。Worker 側の `serveAuthAgentTransport(...).dispose()` はその port の scope だけを解放し、共有 HTTP transport を終了しません。

client 内部の operation／scope 解放エラーは、成功結果や元の実行エラーを置き換えません。解放処理の例外は DB の rollback を意味しません。commit／rollback 本体の失敗は通常どおり扱います。

## 独自 transport

公開型は `@unacowa/policysql/transport` にあります。

- `createScope({ role? })` は固定 context のローカル handle を作ります。
- `scope.createOperation(command, options)` は不変 command の試行系列を作ります。
- `operation.send({ signal? })` は `{ type: 'response', status, body }` または `{ type: 'failure', code, delivery }` を返します。
- `delivery` は今回の試行の `not-sent`／`possibly-sent` です。前回の未確認結果を消しません。
- `scope.beginShutdown()` は通常の新規操作と未送信操作を停止します。送信済み command の確認と安全な cleanup rollback は区別します。
- `dispose()` は通信資源の解放です。SQL rollback を独自に送信しません。

独自 transport は有限時間で完了し、期限・signal・context 固定を守る必要があります。client は通信待ち用の外側のタイマーを追加しません。応答しない独自 transport まで client 単体で終了させる保証はありません。
