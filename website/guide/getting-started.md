---
title: クイックスタート
description: PolicySQLへ最初のSELECTを送信する手順です。
---

# クイックスタート

このページでは、ブログから「自分が書いた公開済みpostの一覧」を取得する例を使って、SQL実行の基本形を示します。

## この例で使うDB構成

ブログでよくある`authors`と`posts`の2テーブルを使います。一人のauthorが複数のpostを書ける、1対多の構成です。

```sql
CREATE TABLE authors (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE posts (
  id TEXT PRIMARY KEY NOT NULL,
  author_id TEXT NOT NULL REFERENCES authors(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES authors(id)
) STRICT;
```

```text
authors
  id = author_01
       |
       +---- posts.author_id = author_01
             posts.id        = post_01
             posts.title     = First post
             posts.status    = published
```

| テーブル | 役割 |
| --- | --- |
| `authors` | 記事を書く人を保存する |
| `posts` | 記事と、その記事を書いたauthorのIDを保存する |

`posts.author_id`が`authors.id`を参照することで、どのauthorが書いたpostかを判定できます。

この例ではpolicyの基本に集中するため、`posts`だけをSELECTします。author名も必要な場合は、`authors`をJOINできます。

PolicySQLには`posts`テーブルを同じ名前の`posts` resourceとして登録します。resourceは、PolicySQLがpolicyを適用するデータの単位です。

## この例の利用者

利用者は、IDが`author_01`のauthorとします。ログイン後、認証serviceは次のclaimsを持つJWTを発行します。

```json
{
  "sub": "author_01",
  "iss": "https://auth.example.com/",
  "aud": "policysql-api",
  "iat": 1785686400,
  "exp": 1785690000,
  "policysql": {
    "roles": ["author"],
    "default_role": "author",
    "access": ["catalog", "explain", "execute"],
    "session": {}
  }
}
```

ここで使う値の意味は次のとおりです。

| 値 | 意味 | この例での用途 |
| --- | --- | --- |
| `policysql.default_role` | 通常使う権限区分 | `author`に許可された操作と列を選ぶ |
| `policysql.roles` | 利用者が選択できるrole | この例では`author`だけを許可する |
| `policysql.access` | 呼び出せるAPI種別 | Catalog、Explain、SQL実行を許可する |
| `sub` | 認証された主体のID | `subject_id`としてpolicyから参照し、`author_01`が書いたpostだけに絞り込む |

これらはSQL request bodyへ入力する値ではありません。PolicySQLがJWTの署名、issuer、audience、有効期限を検証してからsession variableとして使用します。

## 管理者が設定するポリシー

管理者は、`author`が`posts`テーブルを読むためのSELECT policyを設定します。

```yaml
select:
  columns: [id, title, status]
  filter:
    author_id:
      eq:
        session: subject_id
  limit: 100
```

このpolicyは次の内容を表します。

- `author`は`id`、`title`、`status`を参照できる
- `posts.author_id`がJWTの`sub`から作られた`subject_id`と一致する行だけを取得できる
- 一度に取得できるのは最大100行

ここまでの設定に加えて、PolicySQL gatewayのURLとJWT access tokenが発行されていれば、SQL requestを送信できます。

## リクエストを送る

SQL中の値は文字列へ埋め込まず、named parameterとして送ります。

```bash
curl --request POST 'https://gateway.example.com/v1/transactions:execute' \
  --header 'Authorization: Bearer <JWT>' \
  --header 'Content-Type: application/json' \
  --data '{
    "statements": [
      {
        "sql": "SELECT id, title FROM posts WHERE status = :status LIMIT :limit",
        "params": {
          "status": "published",
          "limit": 20
        }
      }
    ]
  }'
```

PolicySQLは、SQLに含まれる`:status`と`:limit`を`params`の同名keyへ対応付けます。

`statements`は1件以上の配列です。追加のSELECTを同じrequestで実行する場合は、独立した`sql`と`params`を持つ要素を配列へ追加します。1件の場合もscalar形式へ変更しません。

## レスポンスを受け取る

成功時は、SELECT句に指定した列と、条件に一致した行が返ります。

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
            {
              "name": "id",
              "type": "string",
              "representation": "string",
              "nullable": false
            },
            {
              "name": "title",
              "type": "string",
              "representation": "string",
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

単一statementでもresponseは`results[]`です。`results[0].rowCount`は返されたrow数で、policyによって非表示になったrow数は通知されません。`results[0].meta.result.columns`にはSQLのaliasや式を反映したlogical type、JSON representation、任意のformat、nullable性が含まれます。policyが投影値を`null`へ置換した場合は、そのcellが`results[0].meta.result.redactions`に記録されます。

## PolicySQLが適用する制約

利用者が送信した`WHERE status = :status`に加えて、「`posts.author_id`がJWTの`sub`から作られた`subject_id`と一致する行だけを取得する」というpolicy条件が常に適用されます。利用者側からこの条件を削除したり、別のauthorのIDへ変更したりすることはできません。

policyに`limit: 100`が設定されている場合、次のように処理されます。

| 利用者のLIMIT | 実効上限 |
| ---: | ---: |
| 20 | 20 |
| 200 | 100 |
| 指定なし | 100 |

## 次に読む

- SQLの細かな対応範囲は[対応するSELECT](../sql/select)
- データの書き込みは[追加・更新・削除](../sql/mutations)
- parameterの規則は[SQLパラメータ](../sql/parameters)
- tokenとroleの規則は[JWT認証](../security/jwt)
- access controlは[認証とポリシー](../security/auth-and-policy)
- 事前確認は[Explain API](../api/explain)
- TypeScriptから使う場合は[Kysely client](../clients/kysely)
- 型、format、constraintの保証は[データ正常性](../data-validity/overview)
