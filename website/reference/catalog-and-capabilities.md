---
title: CatalogとCapabilities
description: 利用可能なlogical schemaとSQL capabilityを確認します。
---

# CatalogとCapabilities

両endpointの取得にはJWTの`catalog` accessが必要です。

Catalogは利用可能なlogical schemaを、Capabilitiesはdeploymentが安全に処理できるSQL機能とlimitを表します。

policyはlogical resource名だけを参照します。logical resourceと物理database、schema、tableの対応はcatalogが管理するため、resource policyへtable名を重複して記載しません。

## Logical catalog

`GET /v1/catalog`は、認証されたroleから見えるresourceとcolumnを返します。

```http
GET /v1/catalog HTTP/1.1
Authorization: Bearer <JWT>
PolicySQL-Role: author
```

```json
{
  "schemaVersion": "schema_17",
  "policyVersion": "policy_42",
  "role": "author",
  "resources": [
    {
      "name": "posts",
      "operations": {
        "select": {
          "columns": [
            { "name": "id", "type": "string", "representation": "string", "nullable": false, "nullableOnDenied": false, "usage": ["projection", "predicate", "join", "order"] },
            { "name": "title", "type": "string", "representation": "string", "nullable": false, "nullableOnDenied": false, "usage": ["projection", "predicate", "join", "order"] },
            { "name": "private_note", "type": "string", "representation": "string", "nullable": false, "nullableOnDenied": true, "usage": ["projection"] },
            { "name": "published_at", "type": "instant", "representation": "string", "format": "rfc3339", "nullable": false, "nullableOnDenied": false, "usage": ["projection", "predicate", "join", "order"] }
          ],
          "allowAggregations": false,
          "allowWindows": false,
          "maxRows": 100
        },
        "insert": {
          "columns": [
            { "name": "title", "type": "string", "representation": "string", "nullable": false, "required": true },
            { "name": "status", "type": "string", "representation": "string", "nullable": false, "required": false, "constraints": { "enum": ["draft", "published", "archived"] } }
          ],
          "returning": {
            "columns": [
              { "name": "id", "type": "string", "representation": "string", "nullable": false, "nullableOnDenied": false, "usage": ["projection"] }
            ]
          }
        },
        "update": {
          "columns": [
            { "name": "title", "type": "string", "representation": "string", "nullable": false },
            { "name": "status", "type": "string", "representation": "string", "nullable": false, "constraints": { "enum": ["draft", "published", "archived"] } }
          ]
        }
      }
    }
  ]
}
```

`transactions.maxStatements`はAtomic Executeの`statements[]`へ指定できる要素数の上限です。SQL text、parameter、row、result byte、execution timeの各limitはstatement単位だけでなくtransaction全体にも累積して適用されます。

このresponseはraw database schemaではありません。非公開resource、policyだけが使用するcolumn、physical table名を含めない場合があります。

`type`は値の意味、`representation`はJSON上の基本表現、`format`はencode・decode規則を示します。SQLite storage classやdeclared typeをそのまま公開するfieldではありません。詳しくは[型・フォーマット・制約](../data-validity/types-and-formats)を参照してください。

`nullable`はlogical schema上で元の値が`null`になりうることを示します。`nullableOnDenied`は、選択中のroleではcolumn visibilityがrowごとにdenyされ、結果が`null`になりうることを示します。どちらかが`true`なら、生成されるTypeScriptの読み取り型は`T | null`になります。

`usage`はclient SQLでcolumnを使用できるcontextです。文字列形式の`columns` itemはpolicyとCapabilitiesで実際に利用可能なcontextを持ちます。`allowAggregations: false`なら`group`と`aggregate`、`allowWindows: false`なら`window`を含めません。条件付きobjectは`["projection"]`だけを持ちます。Catalogは開発支援であり、最終的なcontext permissionはrequestごとにgatewayが再検証します。

`operations.insert.columns`と`operations.update.columns`はroleが書き込める入力contractです。insertの`required`は、presetやdatabase defaultでは補われず、client入力が必要なcolumnを示します。preset-only、policy内部、非公開columnは列挙しません。各mutationの`returning.columns`は独立した出力contractです。operation自体がない場合、そのoperationはdenyです。

Catalogはroleとpolicyに依存します。clientがCatalogや生成型をcacheする場合は、`schemaVersion`だけでなく`policyVersion`と`role`も含む組をcache keyとして使用します。

## Capabilities

`GET /v1/capabilities`は、clientが利用できるSQL機能と運用limitを返します。

```json
{
  "sqlDialect": "sqlite",
  "typeRegistryVersion": "types_3",
  "functionRegistryVersion": "functions_7",
  "statements": ["select", "insert", "update", "delete"],
  "select": {
    "joins": ["inner", "left"],
    "subqueries": true,
    "subqueryForms": ["correlated_exists", "transparent_derived"],
    "ctes": "non_recursive",
    "cteForms": ["single_transparent", "single_filtered_before_join"],
    "aggregations": true,
    "windowFunctions": true,
    "functions": ["count", "lower", "upper", "json_extract"]
  },
  "mutations": {
    "presets": true,
    "returning": true,
    "atomicPostChecks": true
  },
  "parameters": {
    "named": true,
    "positional": false
  },
  "transactions": {
    "atomicExecute": true,
    "interactive": true,
    "commitChecks": true,
    "commitCheckQueries": true,
    "modes": ["read", "write"],
    "maxStatements": 20,
    "maxInteractiveDurationMs": 4000,
    "maxCommitChecks": 4,
    "maxCallbackQueriesPerCheck": 8,
    "maxCallbackRowsPerCheck": 1000,
    "maxCallbackBytesPerCheck": 1048576,
    "maxHookDurationMs": 1500
  },
  "limits": {
    "maxRequestBytes": 65536,
    "maxSqlBytes": 16384,
    "maxParameters": 100,
    "maxAstDepth": 32,
    "maxExpressionNodes": 1000,
    "maxJoins": 8,
    "maxGroups": 1000,
    "maxRows": 1000,
    "maxResultBytes": 1048576,
    "compileTimeoutMs": 250,
    "executionTimeoutMs": 3000
  },
  "idempotency": {
    "retentionSeconds": 86400,
    "maxKeyBytes": 128,
    "keyPattern": "^[A-Za-z0-9._~-]+$"
  }
}
```

code generatorやquery builderは、固定された想定ではなくCapabilitiesを参照して利用機能を決定できます。ただし、Capabilitiesに掲載された機能でも、resource policyが許可するとは限りません。

`maxAstDepth`、`maxExpressionNodes`、`maxJoins`などはcompile前後に検査する構造上限です。`executionTimeoutMs`、`maxRows`、`maxResultBytes`はruntimeにも強制します。SQLite/Tursoが正確なscan row数やcostを事前提供しない場合、その値を保証するfieldは掲載せず、timeoutと結果上限でfail closedにします。

PolicySQLへ接続するdriverがCatalogとresult metadataを処理する規則は[Client開発ガイド](../clients/driver-development)を参照してください。

## Version handling

SQL実行結果には、compile時に使用したpolicy versionとschema versionを含めます。clientは調査・監査用にこれらをrequest IDと一緒に記録でき、取得済みCatalogとの対応も確認できます。

generated clientはCatalog取得時のpolicy versionとschema versionをrequestの`expected`へ送ります。互換性のない更新後に古いrequestを実行すると`POLICYSQL_STALE_OPERATION`が返るため、clientはCatalogを再取得して型とoperationを再生成します。
