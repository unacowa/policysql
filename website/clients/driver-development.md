---
title: Client開発ガイド
description: PolicySQLへ接続するdriver、query builder adapter、code generatorの型処理仕様です。
---

# Client開発ガイド

このページは、PolicySQLのHTTP APIへ接続するdatabase driver、Kysely dialect、query builder adapter、code generatorの開発者を対象にします。applicationから公式Kysely clientを利用する場合は[Kysely client](./kysely)を参照してください。

driverはsecurity boundaryではありません。SQL、parameter、role、型はgatewayがrequestごとに再検証します。driverの責務は、Catalogとresult metadataを使って、値をlosslessかつ予測可能にapplication型へ対応付けることです。

## 起動時の処理

driverまたはcode generatorは、対象roleで`GET /v1/catalog`と`GET /v1/capabilities`を取得します。query固有型を生成する場合は、続けて`POST /v1/transactions:explain`を呼び出します。

```text
JWTとrole
  -> Catalog取得
  -> schemaVersion・policyVersion・roleでcache
  -> resourceとcolumnの型を生成
  -> static queryをExplainでcompile
  -> parameter型とresult型を生成
  -> queryを実行
  -> result descriptorでresponseをdecode
```

Catalog cacheのkeyは`schemaVersion`、`policyVersion`、`role`の組です。同じphysical schemaでも、roleまたはpolicyが違えば、利用可能なresource、column、`nullableOnDenied`が異なる場合があります。

generated operationはcache keyの`schemaVersion`と`policyVersion`をrequestの`expected`へ送ります。`POLICYSQL_STALE_OPERATION`ではCatalogを再検証し、型とoperationを再生成します。stale writeを新snapshotへ自動retryしません。

code generatorのbuild tokenは`catalog`と`explain` accessだけを持ちます。database credentialまたは`execute` accessをcode generationへ使用しません。

## Online query型生成

generatorはstatic SQLごとにExplainへ`params: {}`を送信します。ExplainはSQLを実行せず、client parameterとresult columnを返します。

```json
{
  "statements": [
    {
      "sql": "SELECT 1 AS value",
      "params": {}
    }
  ]
}
```

各`statements[]` itemは次のdescriptorを返します。

```json
{
  "parameters": [],
  "result": {
    "columns": [
      {
        "name": "value",
        "type": "integer",
        "representation": "number",
        "nullable": false
      }
    ]
  }
}
```

生成cache keyにはendpoint identity、role、schemaVersion、policyVersion、compiler version、Capabilities/function registry version、canonical SQL hashを含めます。異なるroleまたはsnapshotの結果を再利用しません。

複数queryのうち一つでもcompileできない場合は生成全体を失敗させ、既存生成fileを部分更新しません。生成物は一時directoryへ作成し、全query成功後にatomic replacementします。

## 型記述子

driverはCatalog columnとquery resultで共通する型記述子を扱います。

```ts
export type JsonRepresentation =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'

export interface ValueDescriptor {
  type: string | string[]
  representation: JsonRepresentation
  format?: string
  nullable: boolean
}

export interface CatalogColumn extends ValueDescriptor {
  name: string
  nullableOnDenied: boolean
  usage: Array<
    | 'projection'
    | 'predicate'
    | 'join'
    | 'order'
    | 'group'
    | 'aggregate'
    | 'window'
  >
  constraints?: Record<string, unknown>
  jsonSchema?: Record<string, unknown>
}

export interface ResultColumn extends ValueDescriptor {
  name: string
}

export interface InsertColumn extends ValueDescriptor {
  name: string
  required: boolean
  constraints?: Record<string, unknown>
}

export interface OperationCatalog {
  select?: {
    columns: CatalogColumn[]
    allowAggregations: boolean
    allowWindows: boolean
    maxRows: number
  }
  insert?: { columns: InsertColumn[]; returning?: { columns: CatalogColumn[] } }
  update?: { columns: ResultColumn[]; returning?: { columns: CatalogColumn[] } }
  delete?: { returning?: { columns: CatalogColumn[] } }
}
```

各fieldの意味と推論規則は[型・フォーマット・制約](../data-validity/types-and-formats)を参照してください。

Catalog columnはbase columnの契約です。result columnはalias、JOIN、式、function、aggregate、policy projectionを適用した後、実行成功responseへ付与されるclient metadataです。driverはresult columnの型をCatalogだけから再構築せず、responseの`meta.result.columns`を使用します。`type`が配列なら、値は列挙されたlogical typeの有限unionです。

code generatorはselect、insert、update、returningを別々に読み取ります。selectできることからwrite可能性を推測せず、insertの`required`から入力必須性を決めます。operationまたはcolumnがCatalogにない場合、そのroleの生成APIから除外します。

## TypeScriptへの標準mapping

標準code generatorは、次のmappingを基本とします。

| PolicySQL descriptor | TypeScript |
| --- | --- |
| `string / string` | `string` |
| `integer / number` | `number` |
| `int64 / string / int64` | `bigint`またはbranded decimal string |
| `number / number` | `number` |
| `boolean / boolean` | `boolean` |
| `bytes / string / base64` | branded base64 stringまたは`Uint8Array` codec |
| `date / string / iso-date` | branded string |
| `datetime / string / sqlite-datetime` | branded string |
| `instant / string / rfc3339` | branded string |
| `json / object` | generated JSON typeまたは`unknown` |

日時を標準でJavaScriptの`Date`へ変換しません。`date`は時点ではなく、`datetime`はtimezoneが確定していない場合があり、`Date`へ変換すると意味が変わるためです。

```ts
export type IsoDate = string & {
  readonly __policySqlType: 'date:iso-date'
}

export type Rfc3339Instant = string & {
  readonly __policySqlType: 'instant:rfc3339'
}
```

applicationが希望する場合、明示的なcodecで`Temporal.PlainDate`、`Temporal.Instant`、`Date`などへ変換できます。codecは`type`だけでなく`representation`と`format`の組を確認します。

## Query resultのdecode

Atomic Executeの成功responseではtop-level `results[]`が常に返り、各resultに`meta.result.columns`と`meta.result.redactions`があります。単一statementでも配列を省略しません。

```json
{
  "transactionId": "tx_01",
  "status": "committed",
  "results": [
    {
      "columns": ["today"],
      "rows": [
        { "today": "2026-08-03 12:34:56" }
      ],
      "rowCount": 1,
      "meta": {
        "operation": "select",
        "result": {
          "columns": [
            {
              "name": "today",
              "type": "datetime",
              "representation": "string",
              "format": "sqlite-datetime",
              "nullable": false
            }
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

driverは次の順で処理します。

1. `results.length`がrequestの`statements.length`と一致することを確認する
2. 各resultで`meta.result.columns`の数、順序、名前を`columns`と照合する
3. 各non-null値が`representation`と一致することを確認する
4. 登録されたcodecがあれば`format`に従ってdecodeする
5. 未知の`type`でも既知の`representation`なら、値を保持してtype tagを上位APIへ渡す
6. decode不能、descriptor矛盾、non-null columnのNULLはprotocol errorとして扱う

gatewayもruntime validationを行いますが、driverは壊れたproxy、version不整合、client bugを型変換で隠さないためにresponse contractを検証します。

## Policy nullableとredaction

Catalogの`nullableOnDenied: true`は、そのroleでbase columnがpolicyにより`null`化されうることを示します。生成する読み取り型は通常の`T | null`とし、必要ならbranded aliasで理由の可能性を保持します。

policy nullable columnの`usage`は`["projection"]`です。driverやquery builderは可能な範囲でWHERE、JOIN、ORDER、GROUPなどの候補から除外します。ただし、client型はsecurity boundaryではなく、gatewayがcontextを再検証します。

```ts
export type NullableOnDenied<T> = T | null
```

どのcellのvisibilityがpolicyでdenyされたかは、query responseの`meta.result.redactions`で判別します。

```ts
export interface PolicyRedaction {
  row: number
  column: string
  code: 'POLICY_REDACTED'
}
```

`row`はresponse `rows`に対する0始まりのindex、`column`はalias適用後の一意な結果列名です。visibilityがdenyなら元値がSQL NULLでも記録され、visibilityがTRUEのdatabase NULLは記録されません。

rowsだけを返す簡易APIを提供しても構いませんが、完全なresponseを取得できるAPIを必ず用意します。driver内部でredactionをdatabase NULLへ不可逆に統合しません。

## Parameterのencode

gatewayは、parameterの利用箇所をbound expressionへ解決し、Catalogまたはfunction signatureから期待型を決定します。

```sql
SELECT id
FROM posts
WHERE published_at >= :since;
```

`:since`の期待型は`published_at`から`instant / string / rfc3339`と推論されます。driverはgenerated typeとcodecを使ってRFC 3339文字列を送信し、gatewayが同じformatを再検証します。

```json
{
  "params": {
    "since": "2026-08-03T12:00:00Z"
  }
}
```

期待型を利用箇所から一意に決められないparameterはgatewayが拒否します。driverがSQL textを独自parseして型を推測したり、最初のruntime valueから型を固定したりしません。

## Functionと式

base columnを参照しない結果型は、gatewayのfunction・operator registryが決定します。

```sql
SELECT datetime('now') AS today;
```

driverが`datetime()`を特別扱いする必要はありません。responseのresult descriptorをdecodeします。code generatorがquery expressionの型も静的に提供する場合は、Capabilitiesと同じversionのfunction signature packageを使用します。

Kyselyなどclient側の型推論とgatewayの型推論が一致しない場合、gatewayの結果契約を正とします。互換性のない差は黙って変換せず、driver errorとして報告します。

## Mutationとtransaction

`INSERT`、`UPDATE`、`DELETE ... RETURNING`もSELECTと同じresult descriptorとredaction規則を使用します。`RETURNING`がない場合は`columns`、`rows`、`meta.result.columns`、`meta.result.redactions`が空配列です。

atomic executeでは`results[]`ごとにdescriptorを処理します。対話型transactionではstatement responseごとに処理します。transaction全体の`meta`とstatement resultの`meta`を混同しません。

## Error handling

driverは少なくとも次を区別します。

| 分類 | 例 |
| --- | --- |
| request error | unsupported SQL、parameter type mismatch |
| authorization error | forbidden resource・column・operation |
| schema error | stale Catalog、result descriptor mismatch |
| decode error | representationまたはformatに適合しない値 |
| transaction error | rollback、期限切れ、commit check deny |
| transport error | timeout、接続失敗、malformed response |

error messageへJWT、hook capability、database credential、protected SQLを含めません。serverの安全なerror codeと`requestId`を保持し、application固有の例外へ対応付けます。

## Compatibility

- 未知のresponse fieldは、同じmajor protocol versionでは保持または無視できる
- 未知の`representation`はdecodeしない
- 未知の`format`は暗黙変換せず、raw representationを返すかstrict modeで失敗する
- `schemaVersion`変更後はCatalogとgenerated typeを更新する
- `policyVersion`またはrole変更後はpermissionと`nullableOnDenied`を更新する
- driverの型情報を認可判定には使用しない
