---
title: PolicySQL 利用者ガイド
description: 信頼できないSQLite SQLへ、宣言的なデータアクセスポリシーを適用するためのガイドです。
---

# PolicySQL 利用者ガイド

<p class="doc-intro">
PolicySQLは、アプリケーションから受け取ったSQLite SQLを検査し、行・列・操作のポリシーを適用してから、TursoまたはlibSQLへ渡すSQLポリシーゲートウェイです。
</p>

<div class="doc-path">
  <a href="./guide/getting-started">
    <strong>SQLを実行する</strong>
    <span>対応するSELECTとHTTPリクエストを確認します。</span>
  </a>
  <a href="./security/jwt">
    <strong>アクセス制御を理解する</strong>
    <span>JWT、role、session、行フィルター、列権限を確認します。</span>
  </a>
  <a href="./admin/policies">
    <strong>ポリシーを管理する</strong>
    <span>resourceごとのpolicy documentを定義します。</span>
  </a>
</div>

## PolicySQLが行うこと

PolicySQLは、利用者から届いたSQLをそのままデータベースへ転送しません。次の条件をすべて満たすSQLだけを受け付けます。

- 一度のリクエストにSQL statementが一つだけ含まれる
- SQLが公開された対応範囲に収まっている
- tableとcolumnをcatalog上で一意に解決できる
- JWTから選択されたroleに、対象resourceと操作のpolicyが存在する
- SQL内で参照するすべてのcolumnが許可されている
- 行フィルターや最大取得件数を弱める操作がない
- serverが所有するparameterを利用者が指定していない

条件を満たさない場合は、SQLを実行せずにエラーを返します。未対応のSQLを部分的に解釈して実行することはありません。

## 利用できるSQL

PolicySQLはparameterized SQLite SQLを受け付けます。SELECT、JOIN、subquery、CTE、集約、並び替えと、policyで許可されたINSERT、UPDATE、DELETEを利用できます。

```sql
SELECT id, title
FROM posts
WHERE status = :status
LIMIT 20;
```

すべてのSQLite構文を受け付けるわけではありません。DDL、transaction control、`PRAGMA`など、public endpointから利用できない操作は[制限事項](./reference/limitations)を参照してください。

## ドキュメントの対象読者

| 読者 | 最初に読むページ |
| --- | --- |
| SQLを送信するアプリケーション開発者 | [クイックスタート](./guide/getting-started) |
| 認証・認可を組み込む開発者 | [JWT認証](./security/jwt) |
| data policyを管理する運用者 | [ポリシー管理](./admin/policies) |
| clientやtoolingを実装する開発者 | [Atomic Execute API](./api/execute) |

## セキュリティの前提

SQL、client parameter、HTTP header、session claim、database metadataは、検証が完了するまで信頼されません。PolicySQLを利用していても、database credentialの最小権限化、timeout、監査ログ、tenant分離などの防御を併用してください。
