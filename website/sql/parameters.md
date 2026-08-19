---
title: SQLパラメータ
description: Client parameterの記述、型、予約名、安全な使用方法です。
---

# SQLパラメータ

SQL中の可変値にはnamed parameterを使用します。値をSQL文字列へ直接連結しないでください。

## 基本形

```json
{
  "statements": [
    {
      "sql": "SELECT id, title FROM posts WHERE status = :status",
      "params": {
        "status": "published"
      }
    }
  ]
}
```

SQL中の`:status`が、`params.status`へ対応します。

## 利用できる値

HTTP APIでは次のJSON valueを受け付けます。実際のSQLite bindingとの対応はexpected descriptorとCapabilitiesで確認してください。

| JSON | 用途 |
| --- | --- |
| `null` | SQL NULL |
| boolean | boolean値 |
| 安全な範囲のinteger | SQLite INTEGER |
| finite number | SQLite REAL |
| string | SQLite TEXT |
| object / array | target logical typeがJSONの場合のJSON value |
| base64 string | target logical typeがbytesの場合のSQLite BLOB |

NaN、Infinity、integerとして安全に表現できないJSON numberは拒否されます。

同じJSON stringでも、target descriptorが`int64 / string / int64`なら64-bit integer、`bytes / string / base64`ならBLOBとして検証・encodeされます。parameter単体の見た目から型を決めません。

## Parameterの一致

SQL中で参照するclient parameterには、対応する値が必要です。

```json
{
  "statements": [
    {
      "sql": "SELECT id FROM posts WHERE status = :status",
      "params": {}
    }
  ]
}
```

このrequestは`:status`が不足しているため拒否されます。重複名、曖昧な表記、利用できないparameter syntaxも拒否対象です。

## Server用の予約名

`__policysql_`で始まる名前はPolicySQLが所有します。client SQLと`params`のどちらにも使用できません。

```sql
SELECT id
FROM posts
WHERE author_id = :__policysql_session_subject_id;
```

このSQLは`POLICYSQL_RESERVED_PARAMETER`で拒否されます。server-owned parameterをclientが同じ値で指定しても許可されません。

## LIMIT parameter

LIMIT用parameterは0以上のintegerとして検証されます。

```json
{
  "statements": [
    {
      "sql": "SELECT id FROM posts LIMIT :limit",
      "params": { "limit": 20 }
    }
  ]
}
```

policy limitより大きな値を指定しても、policy limitを超えるrowは返されません。

## 安全な組み立て方

推奨:

```javascript
const request = {
  statements: [{
    sql: 'SELECT id, title FROM posts WHERE status = :status',
    params: { status: userInput }
  }]
}
```

禁止:

```javascript
const request = {
  statements: [{
    sql: `SELECT id, title FROM posts WHERE status = '${userInput}'`,
    params: {}
  }]
}
```

PolicySQLのparseとpolicy検証は、アプリケーション側の安全なparameterizationを置き換えるものではありません。
