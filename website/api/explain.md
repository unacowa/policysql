---
title: Explain API
description: SQLを実行せずにcompileし、parameter型と実行結果metadataの予測を返します。
---

# Explain API

`POST /v1/transactions:explain`はAtomic Executeと同じ`expected`と`statements[]`をparse、bind、policy適用、型推論します。database transactionは開始せず、SQLを実行しません。JWTには`explain` accessが必要です。

## Request

```json
{
  "expected": {
    "schemaVersion": "schema_17",
    "policyVersion": "policy_42"
  },
  "statements": [
    {
      "sql": "SELECT id, title FROM posts WHERE status = :status LIMIT :limit",
      "params": {}
    },
    {
      "sql": "SELECT 1 AS value",
      "params": {}
    }
  ]
}
```

Explainでは`params`にruntime値がなくても、SQL内の利用箇所、Catalog、operator/function registryからparameter descriptorを推論します。`params` object自体はAtomic Executeとの共通shapeを保つため必須です。型を一意に証明できないparameterは、推測せず`POLICYSQL_AMBIGUOUS_PARAMETER_TYPE`で拒否します。

値を指定した場合は型、format、constraintの追加検証に使用できます。JSON path parameterは例外で、値がなければCatalog JSON Schema上の全到達型を有限unionとして予測し、値があればそのpathを検証してExecuteと同じ到達型へ絞ります。いずれの場合もdatabase rowの値から型を推測しません。

## Response

```json
{
  "statements": [
    {
      "index": 0,
      "operation": "select",
      "parameters": [
        {
          "name": "status",
          "type": "string",
          "representation": "string",
          "nullable": false
        },
        {
          "name": "limit",
          "type": "integer",
          "representation": "number",
          "nullable": false,
          "constraints": { "minimum": 0 }
        }
      ],
      "result": {
        "columns": [
          { "name": "id", "type": "string", "representation": "string", "nullable": false },
          { "name": "title", "type": "string", "representation": "string", "nullable": false }
        ]
      },
      "resources": [
        {
          "name": "posts",
          "columns": ["id", "title", "status"],
          "policy": "posts.author.select"
        }
      ],
      "effectiveLimit": 100,
      "serverParameters": ["__policysql_session_subject_id"],
      "warnings": []
    },
    {
      "index": 1,
      "operation": "select",
      "parameters": [],
      "result": {
        "columns": [
          { "name": "value", "type": "integer", "representation": "number", "nullable": false }
        ]
      },
      "resources": [],
      "serverParameters": [],
      "warnings": []
    }
  ],
  "meta": {
    "requestId": "req_07",
    "policyVersion": "policy_42",
    "schemaVersion": "schema_17",
    "role": "author",
    "transactionMode": "read"
  }
}
```

`parameters`はclient-owned named parameterの入力contractです。`result.columns`は実行時に付与される`results[].meta.result.columns`の予測で、alias、式、JOIN、aggregate、policy projection後の型候補と最終nullable性を示します。Executeは実際に与えられたparameterを使って再compileし、成功後のresponseへ確定したmetadataを付与します。

`statements`はrequestと同じ順序です。一つでもcompileできない場合はresponse全体をerrorにし、部分的な型生成結果は返しません。`meta.transactionMode`は全statementから導出した`read`または`write`です。

## 型生成

公式code generatorはこのAPIをbuild stepから呼び出します。生成物には`schemaVersion`、`policyVersion`、role、compiler versionを記録します。通常の`tsc`、application build、runtime query実行は型生成のためのnetwork accessを行いません。

`SELECT 1`は結果名が`"1"`となるため、`{ "1": number }`として生成できますが、式の結果には`SELECT 1 AS value`のような明示aliasを推奨します。

## 公開範囲

deploymentのredaction policyに応じて、policy内部識別子、policy-only column、server parameter名、protected SQL、physical名を省略または一般化できます。`parameters`と`result`は生成に必要なrole-visible情報なので省略しません。

Explainをclient側の認可判定に使用しません。Atomic Executeはrequestごとに改めて認証・compile・検証します。拒否時も禁止column名やpolicy条件を追加公開しません。
