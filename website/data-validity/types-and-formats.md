---
title: 型・フォーマット・制約
description: SQLiteのstorage classとPolicySQLのlogical type、wire representation、format、constraintを分離する仕様です。
---

# 型・フォーマット・制約

PolicySQLは、値の意味、JSON上の表現、encode・decode規則、許容範囲を別の概念として扱います。一つの型名へすべての意味を埋め込みません。

| Field | 意味 | 例 |
| --- | --- | --- |
| `type` | 値の意味と許可される演算。複数候補は有限union | `string`、`integer`、`["integer", "string"]` |
| `representation` | JSON responseとrequestで使用する基本表現 | `string`、`number`、`boolean`、`object`、`array` |
| `format` | representationのencode・decode規則 | `rfc3339`、`iso-date`、`sqlite-datetime`、`uuid` |
| `constraints` | 値域を追加で制限する規則 | `enum`、`minimum`、`maxLength`、`pattern` |

`format`と`constraints`は省略できます。省略は検証を無効にする意味ではなく、そのlogical typeに定義された標準規則だけを適用することを意味します。

## SQLite storageとの分離

SQLiteのstorage classは内部compiled catalogに`storage`として保持します。public Catalogの`representation`とは別です。

```yaml
published_at:
  storage: text
  type: instant
  representation: string
  format: rfc3339
  nullable: false
```

- `storage: text`はSQLiteから読み取る値のclass
- `type: instant`は値が時間軸上の一点であること
- `representation: string`はJSONで文字列として送ること
- `format: rfc3339`は文字列のparse規則

SQLiteの`DATETIME`というdeclared typeだけを根拠に、`datetime`や`instant`へ自動変換しません。SQLiteには専用のdatetime storage classがなく、declared typeと実値のstorage classも一致するとは限らないためです。

## Catalog manifest

Catalog manifestはpolicy fileとは別に管理します。物理resource mappingと、SQLite introspectionだけでは分からない意味情報を記述します。

```yaml
version: 1

resources:
  posts:
    source:
      table: posts

    columns:
      id:
        type: string

      title: {}

      published_at:
        type: instant
        representation: string
        format: rfc3339

      publication_date:
        type: date
        representation: string
        format: iso-date

      metadata:
        type: json
        representation: object
        jsonSchema:
          $schema: https://json-schema.org/draft/2020-12/schema
          type: object
          additionalProperties: false
          properties:
            tags:
              type: array
              items: { type: string }

      status:
        type: string
        constraints:
          enum: [draft, published, archived]
```

`title: {}`のように補足情報がないcolumnは、SQLite schemaから基本型とnullable性を導出します。日時、UUID、JSON、domain固有形式など、storage classだけでは決められないcolumnを明示します。

`type: json`の`jsonSchema`は、SQLite introspectionでは分からないJSON内部の型を補います。Draft 2020-12のうち、型を有限に導出できる`type`、`properties`、`items`、`required`、`additionalProperties`と有限`anyOf`を扱います。外部`$ref`、循環参照、条件付きschemaなど、有限な型と探索範囲を証明できないschemaはCatalog build時に拒否します。

自動導出は保守的です。TEXTは`string / string`、REALは`number / number`、INTEGERは精度を失わない`int64 / string / int64`、BLOBは`bytes / string / base64`になります。ANY、declared typeと実値の契約が不明なcolumn、boolean、safe-number integer、日時、UUID、JSONはmanifestで明示します。column名や`DATETIME`などのdeclared typeだけから意味型を推測しません。

Catalog buildは、manifestと物理schemaを照合します。存在しないresource・column、互換性のないstorage、未知のtype・format、無効なconstraintは有効化前に拒否します。

## Public Catalog

`GET /v1/catalog`は、選択中のroleから見えるclient contractを返します。physical table名と内部storage情報は公開する必要がありません。

```json
{
  "schemaVersion": "schema_18",
  "policyVersion": "policy_42",
  "role": "author",
  "resources": [
    {
      "name": "posts",
      "operations": {
        "select": {
          "columns": [
            {
              "name": "published_at",
              "type": "instant",
              "representation": "string",
              "format": "rfc3339",
              "nullable": false,
              "nullableOnDenied": false,
              "usage": [
                "projection",
                "predicate",
                "join",
                "order"
              ]
            }
          ],
          "allowAggregations": false,
          "allowWindows": false,
          "maxRows": 100
        }
      }
    }
  ]
}
```

Catalogの`constraints`は型生成、入力UI、事前validationに利用できます。ただし、client validationはsecurity boundaryではありません。同じ規則をgatewayが必ず再検証します。

## 標準logical type

標準logical typeは次のとおりです。deployment固有typeを追加する場合も、既知の`representation`と検証規則を登録する必要があります。

| Type | 標準representation | 用途 |
| --- | --- | --- |
| `string` | `string` | 一般文字列 |
| `integer` | `number` | JSON safe integerの範囲に限定した整数 |
| `int64` | `string` | 64-bit整数。`format: int64`で精度を保持 |
| `number` | `number` | 浮動小数点数 |
| `boolean` | `boolean` | 真偽値。SQLiteでは通常INTEGERへ格納 |
| `bytes` | `string` | binary。`format: base64` |
| `date` | `string` | timezoneを持たない暦日 |
| `datetime` | `string` | timezoneが確定していない日時 |
| `instant` | `string` | 時間軸上の一点 |
| `json` | `object`または`array` | JSON value |

SQL式が複数のlogical typeを返し得る場合は、重複を除いて安定順に並べた有限unionを使用します。例えば`json_tree()`で整数と文字列のnodeを選択するresultは`type: ["integer", "string"]`です。unionを構成する各型についてrepresentation、format、constraintを個別に保持し、候補を有限に証明できない場合は拒否します。

`date`、`datetime`、`instant`を同じ型として扱いません。例えば`YYYY-MM-DD`は時刻ではなく、timezoneのない暦日です。RFC 3339のoffset付き日時は`instant`として扱えます。

## Format

formatは安定したidentifierで指定します。任意のformat文字列をclientごとに解釈させません。

```yaml
type: date
representation: string
format: iso-date
```

```yaml
type: instant
representation: string
format: rfc3339
```

```yaml
type: string
representation: string
format: uuid
```

日付、時刻、UUID、email、JSONなどは組み込みparserで検証します。regexだけでは、存在しない日付やRFCの意味規則を正しく検証できません。

## Constraints

constraintはtypeとformatをさらに狭めます。

```yaml
age:
  type: integer
  constraints:
    minimum: 0
    maximum: 150
```

```yaml
display_name:
  type: string
  constraints:
    minLength: 1
    maxLength: 80
```

```yaml
product_code:
  type: string
  constraints:
    pattern: '^[A-Z]{3}-[0-9]{6}$'
```

`pattern`はPolicySQLが規定する安全なregex subsetでcatalog build時にcompileします。backreferenceやlookaroundなど、実装間で意味または実行量が安定しない構文は拒否します。

単一値の普遍的な規則はconstraintに置きます。session、他column、関連resource、transaction post-stateへ依存する規則は、operation checkまたはcommit checkを使用します。

## SQL式の型推論

SQL resultの型は、SQLiteの最初のrowから推測しません。0 rowでは推測できず、SQLiteではrowごとにstorage classが変わりうるためです。PolicySQL compilerが実行前に型を決定します。

型情報のsourceは次のとおりです。

| Expression | 型情報のsource |
| --- | --- |
| base column | compiled Catalog |
| literal | parserが認識したliteral type |
| parameter | 利用箇所の期待型。値依存のJSON pathは、値があればCatalog JSON Schema上の到達先 |
| operator | operator signature |
| function・aggregate | allowlistへ登録されたfunction signature |
| `CASE`などの複合式 | branch型の統合規則 |
| alias | 元expressionのdescriptorを維持 |

未知のfunction、適合するsignatureがない呼び出し、安定した結果型を導出できない式は拒否します。`unknown`として実行してから型を推測するfallbackはありません。

SQLite標準の`json_extract()`、`json_each()`、`json_tree()`にliteral pathを渡す場合は、Catalogの`jsonSchema`から到達する型を導出します。path parameterの値がある場合は、その値を実行前に検証して到達型を導出します。値のないExplainでは、Schema上で到達可能な全型の有限unionを予測として返します。PolicySQL独自のJSON path構文は追加しません。

### datetime関数

`datetime`をCapabilitiesで許可する場合、function registryへ引数、戻り値、nullable規則、許可modifierを登録します。

```yaml
functions:
  datetime:
    arguments:
      - type: string
      - variadic:
          type: string
    returns:
      type: datetime
      representation: string
      format: sqlite-datetime
```

```sql
SELECT datetime('now') AS today;
```

この結果は実行前に次のように型付けされます。

```json
{
  "name": "today",
  "type": "datetime",
  "representation": "string",
  "format": "sqlite-datetime",
  "nullable": false
}
```

function signatureは引数literalを検査して型をrefineできます。例えば`localtime` modifierを許可する場合、UTCを保証する`instant`としては扱いません。

function registryは型signatureに加えて`volatility: immutable | stable | volatile`を保持します。`datetime('now')`のようなstatement内で一定のclock functionは`stable`です。deploymentが明示的に許可できますが、immutable expressionとしてcache、index、constant foldingしません。side effectを持つfunctionはvolatilityに関係なく拒否します。

## 情報の伝播

式を通過した後も、すべてのformatとconstraintが維持されるとは限りません。

| Expression | 規則 |
| --- | --- |
| column alias | type、representation、formatを維持 |
| `CASE` | 全branchが同じ場合だけformatを維持 |
| 文字列連結 | `string`へ戻し、formatとconstraintを破棄 |
| `CAST(... AS TEXT)` | `string`へ変更し、formatを破棄 |
| function | 登録済みsignatureが戻りdescriptorを決定 |
| aggregate | aggregate signatureが戻りdescriptorとnullable性を決定 |

constraintは、関数signatureが保存を明示した場合だけ引き継ぎます。例えば文字列を切り出した後に、元の値のUUID formatや最大長を無条件に維持しません。

## Runtime validation

compilerが決めた内部descriptorは、実行adapterでも検証します。

- SQLite storage classがcompiled catalogと適合する
- JSON representationへlosslessに変換できる
- format parserが値を受理する
- 適用対象のconstraintを満たす
- `nullable: false`の値がNULLではない

不一致の場合、値だけを`null`へ変換したり、別型へ暗黙変換したりしません。queryまたはtransactionをschema mismatchとして失敗させます。

成功responseの`meta.result.columns`には、同じ導出結果を実行後のclient metadataとして付与します。これは返された値をdriverがdecodeするための情報であり、client側の認可判定やgatewayを迂回する事前保証ではありません。型の導出ロジックは実行前の内部検証と共通で、最初のrowやSQLite storage classから推測し直しません。

## Versioning

次の変更はcompiled catalogの`schemaVersion`を変更します。

- logical type、representation、formatの変更
- constraintの追加、削除、変更
- physical schemaまたはresource mappingの変更
- type、format、function registryの互換性に影響する変更

driverとcode generatorは`schemaVersion`、`policyVersion`、`role`を組にしてCatalogをcacheします。型契約が変わった場合、古いgenerated typeやprepared operationを再生成します。
