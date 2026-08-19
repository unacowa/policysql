---
title: Authorごとのpost取得
description: Author filter、column permission、policy limitをまとめた実践例です。
---

# Authorごとのpost取得

この例では、ブログのauthorが、自分で書いたpostだけを取得します。

## Schema

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
  internal_notes TEXT
) STRICT;
```

`posts.author_id`によって、postを書いたauthorを判定できます。`internal_notes`は運営者専用で、authorには公開しません。

## JWT

認証serviceがPolicySQL claimsを持つJWTを発行します。

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

## Policy

```yaml
resource: posts

roles:
  author:
    select:
      columns: [id, title, status]
      filter:
        author_id:
          eq:
            session: subject_id
      limit: 100
      allow_aggregations: false
```

このresource fileはroot `policy.yaml`の`includes`から読み込みます。bundle構成は[ポリシー管理](../admin/policies)を参照してください。

`author_id`はpolicy filterで使いますが、client SQLへ許可する`columns`には含めません。`internal_notes`も非公開です。

## 許可されるrequest

```json
{
  "statements": [
    {
      "sql": "SELECT id, title FROM posts WHERE status = :status LIMIT :limit",
      "params": {
        "status": "published",
        "limit": 20
      }
    }
  ]
}
```

このrequestには次の制約が適用されます。

- `posts.author_id`がJWTの`sub`から作られた`subject_id`である`author_01`と一致する行だけを対象にする
- clientの`status = :status`も維持する
- 最大20行を返す
- `id`と`title`だけを返す

## Policy limitが優先されるrequest

```json
{
  "statements": [
    {
      "sql": "SELECT id, title FROM posts LIMIT :limit",
      "params": { "limit": 500 }
    }
  ]
}
```

clientは500を指定していますが、policy limitが100なので、実効上限は100です。WHEREを省略してもauthor filterは省略されません。

## 拒否されるrequest

```sql
SELECT id
FROM posts
WHERE internal_notes IS NOT NULL;
```

`internal_notes`は許可columnではないため、SELECTする列に含めていなくても`POLICYSQL_FORBIDDEN_COLUMN`になります。

次のrequestも拒否されます。

```sql
SELECT id
FROM posts
WHERE author_id = :__policysql_session_subject_id;
```

clientがserver-owned parameterを使用しているためです。
