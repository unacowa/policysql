---
title: Atomic Execute API
description: 一つ以上のSQL statementを一つのatomic transactionとして実行するAPI contractです。
---

# Atomic Execute API

`POST /v1/transactions:execute`は、認証されたsessionと一つのpolicy/Catalog snapshotを使い、`statements[]`に指定された一つ以上のSQL statementを順番に実行します。JWTには`execute` accessが必要です。複数statementを標準形とし、1件の場合も同じ配列と`results[]`を使用します。

途中結果を見てから次のSQLを決める場合だけ、[対話型Transaction API](./transactions)を使用します。

## Request

```http
POST /v1/transactions:execute HTTP/1.1
Authorization: Bearer <JWT>
PolicySQL-Role: author
Content-Type: application/json
```

次は二つのSELECTを同じread transactionで実行します。

```json
{
  "expected": {
    "schemaVersion": "schema_17",
    "policyVersion": "policy_42"
  },
  "statements": [
    {
      "sql": "SELECT id, title FROM posts WHERE status = :status LIMIT :limit",
      "params": {
        "status": "published",
        "limit": 20
      }
    },
    {
      "sql": "SELECT id, name FROM authors WHERE id = :author_id",
      "params": {
        "author_id": "author_01"
      }
    }
  ]
}
```

| Field | Required | Description |
| --- | --- | --- |
| `expected` | no | Catalog取得時のschema/policy version。不一致なら何も実行しない |
| `statements` | yes | 実行順のstatement object。1件以上、Capabilitiesの`maxStatements`以下 |
| `statements[].sql` | yes | 対応範囲に含まれる正確に一つのSQL statement |
| `statements[].params` | yes | statement専用のclient-owned named parameter。値がなければ空object |
| `statements[].expect.affectedRows` | no | mutationが変更すべきrow数 |
| `statements[].expect.rowCount` | no | SELECTまたはRETURNINGが返すべきrow数 |

一つの`sql`文字列へsemicolonで複数statementを入れることはできません。複数statementは別々の配列要素にします。各要素は独立した`params`と`expect`を持ちます。

client指定IDはありません。`results`は`statements`と同じ順序で、error `path`は`/statements/0`のような0始まりのindexを使用します。

## Transaction mode

clientは`mode`を指定しません。PolicySQLが全statementを実行前にparse、bind、authorizeしてmodeを決定します。

- すべてSELECT: read transaction
- 一つでもINSERT、UPDATE、DELETEを含む: write transaction

write transactionでは`Idempotency-Key` headerが必須です。SELECTだけのrequestでは任意です。mutationをkeyなしで送った場合、database execution前に拒否します。

```http
Idempotency-Key: 0198f8f1-...
```

## Atomicity

すべてのstatementは配列順に同じtransactionで実行されます。後続statementは、それ以前の未commit変更を読み取れます。

次のいずれかが失敗すると、変更全体をrollbackし、途中の`results`は返しません。

- SQL parse、bind、policy、parameter、type validation
- statement execution
- operation check
- `expect`
- commit check
- resource limitまたはMVCC commit

atomic execute内で、前のresultを後続statementのparameterへ自動代入する機能はありません。生成IDなどの途中結果が必要なら、client生成IDを使用するか対話型transactionを使用します。

## Success response

responseはtransactionがcommitまたはread完了した後にだけ返ります。

```json
{
  "transactionId": "tx_01",
  "status": "committed",
  "results": [
    {
      "columns": ["id", "title"],
      "rows": [
        { "id": "post_01", "title": "First post" }
      ],
      "rowCount": 1,
      "meta": {
        "operation": "select",
        "result": {
          "columns": [
            { "name": "id", "type": "string", "representation": "string", "nullable": false },
            { "name": "title", "type": "string", "representation": "string", "nullable": false }
          ],
          "redactions": []
        }
      }
    },
    {
      "columns": ["id", "name"],
      "rows": [
        { "id": "author_01", "name": "Alice" }
      ],
      "rowCount": 1,
      "meta": {
        "operation": "select",
        "result": {
          "columns": [
            { "name": "id", "type": "string", "representation": "string", "nullable": false },
            { "name": "name", "type": "string", "representation": "string", "nullable": false }
          ],
          "redactions": []
        }
      }
    }
  ],
  "meta": {
    "requestId": "req_01",
    "policyVersion": "policy_42",
    "schemaVersion": "schema_17",
    "role": "author",
    "commitChecks": "not_triggered"
  }
}
```

| Field | Description |
| --- | --- |
| `transactionId` | 監査と問い合わせに使うtransaction識別子 |
| `status` | 成功時は`committed` |
| `results` | statement順のresult。同じindexのrequest statementに対応する |
| `results[].columns` | projection順のresult column名 |
| `results[].rows` | result row。RETURNINGがないmutationでは空配列 |
| `results[].rowCount` | responseに含まれるrow数 |
| `results[].affectedRows` | mutationが変更したrow数。SELECTでは省略 |
| `results[].meta.operation` | `select`、`insert`、`update`、`delete` |
| `results[].meta.result.columns` | aliasと式を反映したresult descriptor |
| `results[].meta.result.redactions` | 条件付き出力列のvisibilityがdenyだったcell |
| `meta` | request全体で固定されたrequest ID、snapshot、role、commit check状態 |

request全体で共通する`requestId`、`policyVersion`、`schemaVersion`、`role`を各resultへ繰り返しません。

statementが1件の場合も`results`は1要素の配列です。scalar responseへの切り替えはありません。

## Mutation result

mutation resultには`affectedRows`と`meta.mutation`を含めます。

`meta.mutation.operationCheck`は、同じstatement内で検証した場合は`passed`、そのoperationにcheckが設定されていない場合は`not_configured`です。失敗したcheckでは成功response自体を返しません。

```json
{
  "columns": ["id", "status"],
  "rows": [
    { "id": "post_01", "status": "published" }
  ],
  "rowCount": 1,
  "affectedRows": 1,
  "meta": {
    "operation": "update",
    "mutation": {
      "affectedRows": 1,
      "returning": true,
      "operationCheck": "passed"
    },
    "result": {
      "columns": [
        { "name": "id", "type": "string", "representation": "string", "nullable": false },
        { "name": "status", "type": "string", "representation": "string", "nullable": false }
      ],
      "redactions": []
    }
  }
}
```

`RETURNING`がないmutationでは`columns`、`rows`、`meta.result.columns`、`meta.result.redactions`が空配列で、`rowCount`は0です。commit checkの最終状態はtransaction top-levelの`meta.commitChecks`だけに含めます。

## Policy nullable

基底columnのDB nullable性とrole固有の`nullableOnDenied`は[Catalog](../reference/catalog-and-capabilities)にあります。queryごとの最終型は各resultの`meta.result.columns`へ常に返します。

```json
{
  "columns": ["id", "private_note"],
  "rows": [
    { "id": "post_01", "private_note": null }
  ],
  "rowCount": 1,
  "meta": {
    "operation": "select",
    "result": {
      "columns": [
        { "name": "id", "type": "string", "representation": "string", "nullable": false },
        { "name": "private_note", "type": "string", "representation": "string", "nullable": true }
      ],
      "redactions": [
        { "row": 0, "column": "private_note", "code": "POLICY_REDACTED" }
      ]
    }
  }
}
```

`redactions[].row`はそのresultの`rows`に対する0始まりのindexです。visibilityがdenyなら元値がSQL NULLでも記録し、visibilityがTRUEのdatabase NULLは記録しません。

この区別は、protected SQLが条件付き出力ごとにcompiler-ownedのboolean visibility列を同じstatementへ追加して担保します。実行adapterは値とvisibilityを同時に検証し、visibility列をpublic `columns`、`rows`、result descriptorから削除してからresponseを返します。client SQLは`__policysql_` result名を使用できません。

result column名はalias適用後に一意でなければなりません。`id`と`ID`のようなASCII case-insensitive衝突も実行前に拒否します。

## Failure response

一つのstatementが失敗しても、成功したstatementの途中resultは返しません。公開して安全な場合、error `path`で失敗した配列要素を示します。

```json
{
  "error": {
    "code": "POLICYSQL_EXPECTATION_FAILED",
    "message": "A statement result did not satisfy its expectation.",
    "path": "/statements/1/expect/affectedRows",
    "requestId": "req_02"
  }
}
```

共通header、status、snapshot、cacheの規則は[HTTP共通仕様](../reference/http-conventions)を参照してください。
