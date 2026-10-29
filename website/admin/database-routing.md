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

1. `createApp` / `createPolicySqlWorker`の`database`に接続提供処理を設定する。
2. 各`app.fetch`の第4引数に、選択済みの`DatabaseBinding`を渡す。

```ts
const worker = createPolicySqlWorker({
  catalog, policy, physicalSchema,
  schemaVersion, policyVersion, limits,
  database: provider,
});

export const TransactionOwner = worker.TransactionOwner;
export default {
  fetch(request, env, context) {
    const database = registry.binding(env.APPLICATION_DATABASE_ID, env);
    return worker.app.fetch(request, env, context, database);
  },
};
```

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

`DatabaseProvider`には次のメソッドがあります。DBを選ぶメソッドはありません。

| メソッド | 用途 |
| --- | --- |
| `check(binding, env)` | 渡されたbindingが登録済み・互換・有効なら正確に`true`を返す |
| `connect(binding, env, requestId)` | そのDBへのtransportを生成する。transactionは開始しない |

DB注入APIはJWTや認証情報を受け取りません。ラッパーは固定設定、独自の認可service、検証済みtokenなど、自分の設計で接続先を選べます。

SQLのpolicy適用に必要なJWT認証とsessionは別の契約として維持します。DBを渡しても認証を迂回できず、JWTにDB情報を書いても省略したDB引数を補ったり、注入済みDBを変更したりできません。

Tursoを使う場合も、接続設定を明示します。

```ts
new TursoHttpTransport({ url: registeredUrl, authToken: serverOwnedToken }, requestId)
```

providerの各呼出しは、1秒とtransactionの残り時間の短い方に制限されます。期限は接続準備前に決め、BEGINで設定し直しません。providerの例外・単独の1秒上限は詳細を伏せた`POLICYSQL_DATABASE_UNAVAILABLE`、transaction全体の期限超過はHTTP 504の`POLICYSQL_DATABASE_TIMEOUT`になります。TursoへのBEGIN・SQL・COMMITにも残り時間を適用し、期限切れ後のROLLBACKには後処理用の上限時間を確保します。別DBへのフォールバックは行いません。

## DBの束縛とcallback

`DatabaseBinding`には`version: 1`、環境・tenant境界の`scope`、永続的な`databaseId`、経路世代`generation`、`getRuntime().snapshot`と一致する`snapshot`を指定します。文字列は1〜256文字の英数字と`_ . : -`で構成し、秘密情報や追加フィールドは含めません。

PolicySQLはbindingを検証・コピーして固定します。DOには識別情報を渡し、DO側のproviderで同じDBの資格情報を解決します。コスト観測も同じDBを使用します。

validatorのcallbackだけは、ラッパーで`app.fetchCallback(request, env, context)`へ渡します。この入口はcallback専用URLしか受け付けず、ownerが保持するbindingと同じtransaction接続を使います。callback capabilityが必要で、新しいDBを選択・接続する経路はありません。

## 運用と移行

- 再送はDB識別子で分離し、同じキーで経路世代やsnapshotが変わった場合は競合として拒否します。
- 資格情報の更新だけではDB識別子を変更しません。既存接続を失ったtransactionは再接続して続行しません。
- 別の物理DBには新しい識別子を割り当て、旧DBで結果不明の書込みを自動再送しないでください。
- 各DBの実schemaは登録時に管理者が検証・準備します。`Idempotency-Key`付きAtomic Executeを使う場合だけ、`policysql_idempotency`も必要です。キーなしの更新と対話型transactionはこのテーブルを必要としません。
- 固定envを暗黙に使う旧APIからは移行が必要です。未解決の再送を残したまま切り替えないでください。

レート制限もDB選択と同じくラッパーの責務です。サンプルのWorkerは`app.fetch`より前にCloudflare Rate Limiting bindingで制限し、上限超過時は`createErrorResponse`で429 `POLICYSQL_RATE_LIMITED`を返します（[エラー](../api/errors#ラッパーが返すエラー)）。

リポジトリの`examples/database-routing/`にJWTから独立したregistryとWorker/DOサンプルがあります。既存の固定DB配備コードは`deploy/cloudflare/wrapper/`に移し、そこから明示的にDBを注入しています。

ローカルテストは独立SQLite DB・実JWT・WASMを使いますが、通信とDO基盤は模擬です。実Cloudflare/Tursoの受入検証は別途必要です。
