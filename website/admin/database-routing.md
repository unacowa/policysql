---
title: ラッパーからDBを渡す
description: 選択済みのDBをPolicySQLへ明示的に渡す、必須の接続注入APIです。
---

# ラッパーからDBを渡す

PolicySQLを実行する際は、利用者のラッピングコードからDBを必ず渡します。
ライブラリにはDBのデフォルト設定や固定envへのフォールバックがありません。
DBの選択と認可はラッパー側で行い、PolicySQLは渡されたDBで安全に実行します。

初期対応は、同じschema・policy・backend profileを使う複数のSQLite/Turso DBです。

## 必須のAPI引数

`@unacowa/policysql/cloudflare`から公開するAPIには、次の二つを渡します。

1. `createApp` / `createPolicySqlWorker`に接続提供処理（`database`）、設定（`config`）、transaction ownerのport（`transactionOwners`）を渡す。Workersでは`deployment(env)`関数でこれらを組み立てる。
2. 各`app.fetch`の要求context `{ database, session }`（`createPolicySqlWorker().app.fetch`では第4引数）に、選択済みの`DatabaseBinding`と、ラッパーが認証したtrusted sessionを渡す（[JWT認証](../security/jwt)）。

```ts
const worker = createPolicySqlWorker({
  catalog, policy, physicalSchema,
  schemaVersion, policyVersion, limits,
  // ラッパー所有。WorkerとDurable Objectがそれぞれのenvで呼び出す。
  deployment: (env) => ({
    database: registry.provider(env),
    config: configFromEnv(env),
    // transaction ownerはこのデプロイのDurable Object（binding名はラッパーの規約）
    transactionOwners: durableObjectTransactionOwners(env.TRANSACTION_OWNER),
  }),
});

export const TransactionOwner = durableObjectTransactionOwnerClass(worker.ownerDependencies);
export default {
  async fetch(request, env, context) {
    const session = await authenticate(request, env); // 失敗時はラッパーが401を返す
    const database = registry.binding(env.APPLICATION_DATABASE_ID, env);
    return worker.app.fetch(request, env, context, { database, session });
  },
};
```

`limits`（`RuntimeLimits`）は上限を設定する唯一の場所です。対話型transactionの期限、文の数、累積結果bytes、callbackの行数なども省略時は既定値で、Capabilitiesは実際に強制する値を返します。項目、既定値、範囲はリポジトリの`docs/configuration.md`にあります。

ここではラッパーの設定から固定DBを選んでいます。要求単位で選ぶ場合は、アプリケーションが認可したDBのbindingを同じ引数へ渡します。クライアントが指定したIDやURLだけではDB利用の許可になりません。

| 渡し忘れ・不整合 | 挙動 |
| --- | --- |
| 接続providerの省略・不正 | 構築時に`TypeError` |
| 要求のDB引数の省略・null | HTTP 500、`POLICYSQL_DATABASE_REQUIRED` |
| bindingの形式不正・利用不可 | HTTP 403、`POLICYSQL_DATABASE_BINDING_REJECTED` |
| runtime snapshot不一致 | HTTP 409、`POLICYSQL_STALE_OPERATION` |

固定Turso envが存在しても省略はエラーです。TypeScriptでもproviderとDB引数は必須です。
コンパイラだけを作る`createRuntimeFactory`はDBを必要としません。

## 接続提供と認証の分離

`DatabaseProvider`には次のメンバーがあります。DBを選ぶメソッドはありません。

| メンバー | 用途 |
| --- | --- |
| `streamedReadCap` | 必須のboolean。providerが作るtransportが、databaseの応答をstreamで読み、coreが渡す読み取り上限（`maxResponseBytes`）を超えた時点で打ち切るなら`true`。応答を内部でまとめて読むdriver（`@tursodatabase/serverless`など）は`false`にします。`false`のproviderは、`maxResultBytes`が64,000 byteを超えると`database_read_cap_unenforced`を一度だけlogに出します |
| `check(binding)` | 渡されたbindingが登録済み・互換・有効なら正確に`true`を返す |
| `connect(binding, requestId)` | そのDBへのtransportを生成する。transactionは開始しない |

providerはplatformの`env`を受け取りません。ラッパーが自分の認証情報とregistryから組み立てます。

## 設定（`PolicySqlConfig`）

ライブラリはplatformの`env`から何も読みません。Durable Objectのbinding（参考実装では`TRANSACTION_OWNER`）もラッパーが読み、transaction ownerのportとして渡します。設定はラッパーが次の値を明示的に渡します。env名はラッパー側の規約です。

| 設定 | 必須 | 内容 |
| --- | --- | --- |
| `environment` | yes | `/healthz`が返すデプロイ名 |
| `publicBaseUrl` | `commitChecks`がある場合 | validatorがcallbackするHTTPS origin |
| `costCatalog` | no | cost観測の上限（JSON文字列ではなくobject） |
| `commitChecks` | no | policyのcheck IDごとの`{ url, hmacSecret }` |

不正な値は構築時（`createPolicySqlWorker`では最初の要求時）に拒否され、DB・Durable Object・validatorへのアクセス前にHTTP 500 `POLICYSQL_INTERNAL`になります。エラーとログには設定名だけが含まれ、値は含まれません。

DB注入APIはJWTや認証情報を受け取りません。ラッパーは固定設定、独自の認可service、検証済みtokenなど、自分の設計で接続先を選べます。

SQLのpolicy適用に必要な認証はラッパーが行い、trusted sessionを別の契約として渡します。DBを渡しても認証を迂回できず、JWTにDB情報を書いても省略したDB引数を補ったり、注入済みDBを変更したりできません。

Tursoを使う場合も、接続設定を明示します。

```ts
new TursoHttpTransport({ url: registeredUrl, authToken: serverOwnedToken }, requestId)
```

providerの各呼出しは、1秒とtransactionの残り時間の短い方に制限されます。期限は接続準備前に決め、BEGINで設定し直しません。providerの例外・単独の1秒上限は詳細を伏せた`POLICYSQL_DATABASE_UNAVAILABLE`、transaction全体の期限超過はHTTP 504の`POLICYSQL_DATABASE_TIMEOUT`になります。TursoへのBEGIN・SQL・COMMITにも残り時間を適用し、期限切れ後のROLLBACKには後処理用の上限時間を確保します。別DBへのフォールバックは行いません。

## DBの束縛とcallback

`DatabaseBinding`には`version: 1`、環境・tenant境界の`scope`、永続的な`databaseId`、経路世代`generation`、`getRuntime().snapshot`と一致する`snapshot`を指定します。文字列は1〜256文字の英数字と`_ . : -`で構成し、秘密情報や追加フィールドは含めません。

PolicySQLはbindingを検証・コピーして固定します。DOには識別情報を渡し、DO側のproviderで同じDBの資格情報を解決します。コスト観測も同じDBを使用します。

validatorのcallbackだけは、ラッパーで`worker.app.fetchCallback(request, env, context)`（`createApp`では`app.fetchCallback(request)`）へ渡します。この入口はcallback専用URLしか受け付けず、ownerが保持するbindingと同じtransaction接続を使います。callback capabilityが必要で、新しいDBを選択・接続する経路はありません。逆に`app.fetch`はcallbackのrouteを処理しません。percent-encodingでcallbackのpathになるrequestも、bodyを読む前に404を返します。

## 運用と移行

- 再送はDB識別子で分離し、同じキーで経路世代やsnapshotが変わった場合は競合として拒否します。
- 資格情報の更新だけではDB識別子を変更しません。既存接続を失ったtransactionは再接続して続行しません。
- 別の物理DBには新しい識別子を割り当て、旧DBで結果不明の書込みを自動再送しないでください。
- 各DBの実schemaは登録時に管理者が検証・準備します。`Idempotency-Key`付きAtomic Executeを使う場合だけ、`policysql_idempotency`も必要です。キーなしの更新と対話型transactionはこのテーブルを必要としません。
- 固定envを暗黙に使う旧APIからは移行が必要です。未解決の再送を残したまま切り替えないでください。

レート制限もDB選択と同じくラッパーの責務です。サンプルのWorkerは、clientのrequestを`app.fetch`より前に、validatorのcallbackを別のbucketで`app.fetchCallback`より前に、Cloudflare Rate Limiting bindingで制限します。上限超過時は`createErrorResponse`で429 `POLICYSQL_RATE_LIMITED`を返します（[エラー](../api/errors#ラッパーが返すエラー)）。

リポジトリの`examples/database-routing/`にJWTから独立したregistryとWorker/DOサンプルがあります。既存の固定DB配備コードは`deploy/cloudflare/wrapper/`に移し、そこから明示的にDBを注入しています。

ローカルテストは独立SQLite DB・trusted session（またはサンプルのJWT検証）・WASMを使いますが、通信とDO基盤は模擬です。実Cloudflare/Tursoの受入検証は別途必要です。
