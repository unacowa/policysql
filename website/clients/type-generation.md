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
policysql generate \
  --endpoint https://gateway.example.com \
  --role author \
  --input ./queries \
  --output ./src/generated/policysql
```

CLIはbuild専用JWTを`POLICYSQL_CODEGEN_TOKEN`から読み取ります。command argument、生成file、logへtokenを残しません。

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

生成物には使用した`schemaVersion`、`policyVersion`、role、compiler version、query hashを埋め込みます。runtime requestは両versionを`expected`として送ります。不一致なら自動的に新しい型へ読み替えず、`POLICYSQL_STALE_OPERATION`で失敗します。

生成結果はsource repositoryまたはCI artifactへ保存できます。`tsc`とapplication runtimeは型生成のためにPolicySQLへ接続しません。online接続が必要なのは明示的な`policysql generate`だけです。

## 生成失敗

- SQLまたはparameter型を一意に解決できない
- roleがresource、column、operationを利用できない
- 結果名が空または重複する
- schema/policy snapshotが変わった
- function registryまたはCapabilitiesが生成CLIと互換でない
- Explainへの認証、timeout、network accessが失敗した

失敗時は既存生成fileを部分更新しません。CIでは生成差分が残っていないことを検証します。

## 動的SQL

runtimeで構築され、build時にSQL textを確定できないqueryは静的生成対象外です。Kysely自身が推論できる型を利用するか、`unknown`としてruntime result descriptorで検証します。利用者の型assertionはPolicySQLの認可やruntime validationを置き換えません。

parameter化されたJSON pathを値なしでExplainする場合、generatorはCatalog JSON Schema上の全到達型から作られたunionを生成します。path値を固定してExplainした生成物は、その値とquery hashを生成artifactへ含めます。
