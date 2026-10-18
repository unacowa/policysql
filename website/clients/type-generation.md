---
title: TypeScript型生成
description: PolicySQLへonline compileを行い、SQLごとの入力型と結果型を生成します。
---

# TypeScript型生成

公式TypeScript code generatorは、SQLを実行せずPolicySQLのExplain APIへ送信し、role固有のparameter型とresult型を生成します。Turso Databaseへ直接接続せず、database credentialも受け取りません。

## 生成フロー

```text
.sql files
  -> policysql generate
  -> GET /v1/catalog
  -> GET /v1/capabilities
  -> POST /v1/transactions:explain
  -> generated TypeScript
```

```bash
policysql generate --config ./policysql.config.mjs
```

設定モジュールはアプリケーションが管理し、generator の options を default export します。

```js
// policysql.config.mjs
import { createHttpTransport } from '@unacowa/policysql/client'

const endpoint = 'https://gateway.example.com'
export default {
  endpoint, // 生成メタデータ。通信先は下の Transport で設定する
  role: 'author',
  input: './queries',
  output: './src/generated/policysql',
  transport: createHttpTransport({
    endpoint,
    fetchImpl: (url, init) => {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${process.env.BUILD_TOKEN}`)
      return fetch(url, { ...init, headers })
    },
  }),
}
```

認証方式・環境変数名・資格情報の更新はアプリケーションが決めます。CLI に専用 token option はありません。プログラムからは `@unacowa/policysql/generator` の `generate(options)` を使えます。Catalog／Capabilities／Explain の全通信は、注入した関数 Transport を通ります。自動再送や独自 timeout はなく、任意の `signal` を渡せます。

## Build credential

```json
{
  "sub": "build_ci",
  "iss": "https://auth.example.com/",
  "aud": "policysql-api",
  "iat": 1785686400,
  "exp": 1785690000,
  "policysql": {
    "roles": ["author"],
    "default_role": "author",
    "access": ["catalog", "explain"]
  }
}
```

このtokenはCatalog、Capabilities、Explainだけに使用でき、Atomic Execute、対話型transaction、commit-check callbackを呼び出せません。生成対象roleごとにpolicyが許可する情報だけを取得します。

## Queryと生成物

```sql
-- queries/get-published-posts.sql
SELECT id, title
FROM posts
WHERE status = :status
LIMIT :limit;
```

```ts
export interface GetPublishedPostsParams {
  status: string
  limit: number
}

export interface GetPublishedPostsRow {
  id: string
  title: string
}

export const getPublishedPosts: GeneratedPolicyQuery<
  GetPublishedPostsParams,
  GetPublishedPostsRow
>
```

parameter型と静的SQLのresult予測はExplain responseを正とします。SQL textをTypeScript template literal typeだけで再解析したり、利用者のgeneric annotationをgatewayの型より優先したりしません。実行時に返る`meta.result.columns`が実際のparameterに対するclient metadataであり、Explainの予測より狭い有限unionになる場合があります。

## `SELECT 1`

```sql
SELECT 1;
```

PolicySQLは`integer / number / non-null`と推論できます。result名はSQLite規則による`"1"`なので、生成型は次の形になります。

```ts
export interface ConstantRow {
  '1': number
}
```

安定したproperty名にするため、式にはaliasを付けます。

```sql
SELECT 1 AS value;
```

```ts
export interface ConstantRow {
  value: number
}
```

## Snapshotと再生成

生成物には固定した SQL・role・`schemaVersion`・`policyVersion`・query hash を埋め込み、runtime でも書換えを防ぎます。query hash は前後の空白を除いた送信 SQL の SHA-256 です。型は生成時に指定した role に対応します。runtime requestは両versionを`expected`として送ります。不一致なら自動的に新しい型へ読み替えず、`POLICYSQL_STALE_OPERATION`で失敗します。

`metadata.json` に endpoint・role・両 version・SQL hash と Catalog／Capabilities／Explain の型情報を保存します。現在の Gateway の runtime snapshot ID・profile・ABI と、公開される compiler／registry 情報をそのまま記録します。個別の compiler／registry version が未公開の場合は推測・補完せず、公開情報以上の互換性を保証しません。

接続先・DB と成果物の配置・再利用条件は利用者が管理します。Client は Transport の内部から endpoint・資格情報・DB を推測しません。role／version 一致だけでは別 endpoint／DB の同一性は証明できません。

生成結果はsource repositoryまたはCI artifactへ保存できます。`tsc`とapplication runtimeは型生成のためにPolicySQLへ接続しません。online接続が必要なのは明示的な`policysql generate`だけです。

## 生成失敗

- SQLまたはparameter型を一意に解決できない
- roleがresource、column、operationを利用できない
- 結果名が空または重複する
- schema/policy snapshotが変わった
- 未対応の JSON representation、破損した descriptor、Catalog／Capabilities の不整合
- Explainへの認証、timeout、network accessが失敗した

失敗時は既存生成fileを部分更新しません。CIでは生成差分が残っていないことを検証します。

## 動的SQL

runtimeで構築され、build時にSQL textを確定できないqueryは静的生成対象外です。Kysely自身が推論できる型を利用するか、`unknown`としてruntime result descriptorで検証します。利用者の型assertionはPolicySQLの認可やruntime validationを置き換えません。

parameter 化された JSON path を値なしで Explain する場合、generator は返された型と JSON representation を使います。JSON 値は `unknown` とし、Execute の descriptor が狭まっても生成時の予測と完全一致することを要求しません。

## 生成済みクエリのバージョン条件

通常の `PolicySqlClient` は Transport の注入だけで作れます。生成済みクエリには
生成時の role と schema / policy version が必要です。実行する Client に全て明示します。
不一致・省略は送信前に `POLICYSQL_STALE_OPERATION` になります。
実際の server snapshot との一致は gateway が検証します。

```ts
const client = new PolicySqlClient({
  transport,
  role: 'author',
  schemaVersion: getPublishedPosts.schemaVersion,
  policyVersion: getPublishedPosts.policyVersion,
})
const posts = await getPublishedPosts.execute(client, { status: 'published', limit: 20 })
```

ロールを選択する header は `PolicySQL-Role` です。generator の role 指定は引き続き必須です。
