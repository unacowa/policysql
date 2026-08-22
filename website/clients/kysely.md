---
title: Kysely client
description: TypeScriptとKyselyからPolicySQLを利用する公式サポート方針です。
---

# Kysely client

PolicySQLは、TypeScript application向けの公式サポートクライアントとしてKyselyを対象にします。

KyselyはSQL builderとして使い、最終的なSQL実行先はdatabase driverではなくPolicySQL gatewayにします。PolicySQL clientは、Kyselyが生成したSQL、parameters、JWT、roleを受け取り、通常は`POST /v1/transactions:execute`へ送信します。途中結果から次のSQLを作る場合だけ対話型Transaction APIを使用します。

## 対象

- TypeScript application
- KyselyでSQLを組み立てたいclient
- PolicySQLの型生成を使い、roleごとの参照可能列を開発時に確認したいclient

Kyselyの型は開発補助であり、セキュリティ境界ではありません。最終的な認可は、gatewayがrequestごとにSQLをparse、bind、policy適用して判断します。

## 実行の形

```ts
import { createPolicyKysely } from '@unacowa/policysql/kysely'

const policyDb = createPolicyKysely({ kysely: db, client })
const rows = await policyDb
  .selectFrom('posts')
  .select(['id', 'title'])
  .where('status', '=', 'published')
  .limit(20)
  .execute()
```

公式clientは、Kysely queryをPolicySQLのrequestへ変換します。

```json
{
  "expected": {
    "schemaVersion": "schema_17",
    "policyVersion": "policy_42"
  },
  "statements": [
    {
      "sql": "select id, title, author_email from posts where status = :p1 limit :p2",
      "params": { "p1": "published", "p2": 20 }
    }
  ]
}
```

公式clientはKyselyの`OperationNode`を専用SQLite query compilerで再compileし、parameter nodeだけを衝突しないnamed parameterへ変換して上記のwire formatで送信します。SQL文字列への正規表現置換は行わないため、string literalやcomment内の`?`は変更されません。parameter付きqueryが`toOperationNode()`を公開せず、compile済みSQL textしか渡さない場合は、安全に構文境界を復元できないため送信前に拒否します。client applicationはdatabase credentialを持ちません。

生成clientは型生成に使用したCatalogの`schemaVersion`と`policyVersion`を各requestの`expected`へ自動的に付けます。stale errorを受けた場合はCatalogを再取得し、生成物を更新するまで型不一致のrequestを自動retryしません。

## Table型生成

PolicySQLはcompiled CatalogからKysely table用の型定義を生成します。CatalogはSQLite schema、logical type補足、role policyを統合したclient contractです。

```ts
import type { ColumnType } from 'kysely'

export type NullableOnDenied<T> = T | null

export interface DB {
  posts: {
    id: ColumnType<string, never, never>
    title: ColumnType<string, string, string>
    body: ColumnType<string, string, string>
    author_id: ColumnType<string, never, never>
  }
}
```

条件付き出力列は通常のKysely table interfaceへ含めません。これにより標準の`.where()`、`.orderBy()`、JOINなどへ候補として現れません。projectionには公式clientの`policySelect` helperを使用します。helperの生成型は`NullableOnDenied<T>`を通常の`T | null`として返しながら、source mapと生成ドキュメントへpolicy nullable情報を保持します。

日時、UUID、JSONなどはCatalogの`type`、`representation`、`format`から生成します。標準では日時をJavaScriptの`Date`へ暗黙変換せず、意味を保持するbranded stringとして生成します。型体系は[型・フォーマット・制約](../data-validity/types-and-formats)、client実装規則は[Client開発ガイド](./driver-development)を参照してください。

## Query固有の型生成

raw SQL、literal、function、aggregateなどquery固有のparameter/result型はCatalogだけでは決めません。公式generatorがbuild時にPolicySQLのExplain APIへonline compileを行います。

```sql
SELECT 1 AS value;
```

```ts
export interface ConstantRow {
  value: number
}
```

Kysely builder自身が推論できる型はeditor上でそのまま利用できます。生成対象queryについてはExplainのdescriptorを正とし、Kyselyの推論または`sql<T>` annotationと一致しない場合はcode generationを失敗させます。

生成時だけPolicySQLへ接続し、生成されたTypeScriptを通常のbuild inputとして保存します。`tsc`とapplication runtimeは型生成目的のnetwork requestを行いません。CLI、build token、snapshot管理は[TypeScript型生成](./type-generation)を参照してください。

## Role別の型

roleが固定できる環境では、role別DB型を生成できます。

```ts
import type { AuthorDB, AdminDB } from './policysql.generated'

const authorDb = createPolicyKysely<AuthorDB>({ role: 'author' })
const adminDb = createPolicyKysely<AdminDB>({ role: 'admin' })
```

role別型では、そもそも参照できないtableやcolumnを型から外します。行条件によって値が見える場合と`null`化される場合が混在するcolumnは、別のpolicy projection型へ`NullableOnDenied<T>`として生成します。

policy nullable columnはCatalog上で`usage: ["projection"]`を持ち、通常table interfaceとは別の生成interfaceへ出力します。gatewayはWHERE、JOIN、ORDER、GROUP、functionなどでの利用を拒否します。raw SQLやTypeScriptの型escapeは可能なので、gateway enforcementが最終保証です。

```ts
export interface AuthorDB {
  posts: {
    id: string
    title: string
  }
}

export interface AuthorPolicyProjection {
  posts: {
    author_email: NullableOnDenied<string>
  }
}

export interface AdminDB {
  posts: {
    id: string
    title: string
    author_email: string | null
  }
}
```

## Response meta

PolicySQLのwire responseは単一statementでもtop-level `results[]`と`meta`を返します。公式Kysely clientはstatement単位のKysely APIに合わせて`results[0]`を取り出し、通常の`execute()`では`rows`だけを返します。必要な場合はstatement meta付き結果を取得できます。

```ts
import { policyQuery } from '@unacowa/policysql/kysely'

const result = await policyQuery(
  policyDb.selectFrom('posts').select(['id', 'title']),
).executeWithPolicyMeta()

result.rows
result.meta.result.columns
result.meta.result.redactions
```

`meta.result.columns`には、aliasや式を反映した結果列の型と最終的なnullable性が含まれます。基底columnの`nullableOnDenied`はCatalogと生成型に含まれ、query responseでは繰り返しません。

```json
{
  "name": "author_email",
  "type": "string",
  "representation": "string",
  "nullable": true
}
```

`meta.result.redactions`はpolicyのvisibilityがdenyだったcellを示します。値が`null`でもredactionがなければ、visibilityはTRUEで元データがNULLです。元データ自体がNULLでもvisibilityがdenyならredactionを記録します。

```ts
const wasRedacted = result.meta.result.redactions.some(
  (item) => item.row === 0 && item.column === 'author_email',
)
```

`row`は`result.rows`に対する0始まりのindex、`column`はKyselyで指定したalias適用後の結果列名です。公式clientはこの情報を隠しません。利用するかどうかはclient applicationの責務です。

## Mutation

INSERT、UPDATE、DELETEはKyselyのmutation builderから実行できます。

```ts
import { policyMutation } from '@unacowa/policysql/kysely'

const result = await policyMutation(
  policyDb
    .updateTable('posts')
    .set({ title: 'Updated title' })
    .where('id', '=', 'post_01')
    .returning(['id', 'title']),
  { idempotencyKey: crypto.randomUUID() },
).executeWithPolicyMeta()
```

`createPolicyKysely`でbindしたbuilderの通常の`.execute()`も同じPolicySQL境界を通ります。mutationでidempotency keyを省略した場合、Web Cryptoを利用できるruntimeではclientがrequestごとに生成します。再試行を同じoperationとして扱うapplicationは、`policyMutation`へ安定したkeyを明示します。

`RETURNING`がある場合、`result.rows`、`result.meta.result.columns`、`result.meta.result.redactions`が返ります。`RETURNING`がない場合、`result.rows`と`result.meta.result.redactions`は空配列で、`result.affectedRows`と`result.meta.mutation`を確認します。

```ts
result.affectedRows
result.meta.mutation?.operationCheck
result.meta.mutation?.commitChecks
```

## Transaction

複数statementを事前にまとめてatomicに実行する場合は、一つの`statements[]`としてAtomic Executeへ送ります。現行のKysely adapterは`transaction()`をPolicySQLの対話型Transaction APIへ接続しません。次の形は未対応であり、使用するとPolicySQL境界を通るtransactionにはなりません。

```ts
await policyDb.transaction().execute(async (trx) => {
  await trx
    .updateTable('posts')
    .set({ status: 'published' })
    .where('id', '=', 'post_01')
    .execute()

  await trx
    .insertInto('audit_logs')
    .values({ action: 'post.published', post_id: 'post_01' })
    .execute()
})
```

対応済みのatomic client APIまたはHTTP APIを使用し、client SQLとして`BEGIN`、`COMMIT`、`ROLLBACK`を送信しません。

## 制限

- Kyselyの型は認可を保証しない
- 生SQLを使う場合もPolicySQL gatewayで再検証される
- database固有関数や未対応SQLはKyselyで表現できてもPolicySQLで拒否される
- `sql<T>`の`T`は利用者のassertionであり、生成対象queryではExplain descriptorとの一致を検証する
- `NullableOnDenied<T>`は`T | null`として扱えるヒントであり、行ごとの`null`理由は`meta.result.redactions`で区別する
