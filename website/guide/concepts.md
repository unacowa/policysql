---
title: 基本概念
description: PolicySQLのresource、role、session、policy、catalogを説明します。
---

# 基本概念

PolicySQLでは、SQLの文字列ではなく、catalog上で解決したresourceとcolumnに対してpolicyを適用します。

## Resource

policyで保護する論理的なデータ集合です。一つのresourceが一つのSQLite tableへ対応します。複数resourceは、許可されたcolumnを使うSQL JOINで関連付けられます。

例: `posts`、`authors`、`comments`

physical database上の名前をそのまま外部へ公開する必要はありません。利用者にはlogical catalogで許可されたresourceだけを公開できます。

## Role

利用者の権限区分です。認証済みsessionから決定されます。

例: `author`、`editor`、`reader`

同じresourceでも、roleごとに許可するoperation、column、row filter、limitを変更できます。該当するpolicyがないroleは拒否されます。

## Session

検証済みJWTの標準claimとPolicySQL claimsからgatewayが構築する、信頼済みのrequest contextです。

```json
{
  "role": "author",
  "variables": {
    "subject_id": "author_01"
  }
}
```

session値はclientのSQL parameterとは別に管理されます。request bodyや任意のsession headerを追加しても、JWTから作られた値を上書きできません。詳しくは[JWT認証](../security/jwt)を参照してください。

## Policy

roleがresourceへ実行できる操作と、適用する制約を宣言します。

SELECT policyは主に次の要素を持ちます。

| 要素 | 意味 |
| --- | --- |
| `columns` | client SQLから参照できるcolumn |
| `filter` | 常に適用するrow条件 |
| `limit` | 返却できる最大row数 |
| `allow_aggregations` | aggregate function、GROUP BY、HAVINGを許可するboolean。defaultはfalse |
| `allow_windows` | window functionを許可するboolean。defaultはfalse |

## Logical catalog

SQL中のtable、alias、columnを解決するためのschema情報です。存在するphysical tableを自動的にすべて公開するものではありません。

catalogにないresourceやcolumnは、databaseに実在していても利用できません。曖昧な名前や、型・出所を解決できない参照も拒否されます。

Catalogはcolumnのlogical type、JSON representation、任意のformatとconstraintも保持します。SQLiteのstorage classとは分離され、SQL式の型推論とclient型生成に使用されます。詳しくは[データ正常性](../data-validity/overview)を参照してください。

## Client parameterとserver-owned parameter

client parameterは、利用者のSQLに含まれる値です。server-owned parameterは、sessionやpolicyからPolicySQLが生成する値です。両者は別の名前空間として扱われます。

`__policysql_`で始まる名前はserver用に予約され、clientから指定できません。

## Default deny

次のいずれかに該当する場合、PolicySQLはrequestを拒否します。

- policyがない
- SQL nodeやclauseが未対応
- resourceまたはcolumnを解決できない
- parameterに不足・衝突・不正な型がある
- policyを安全に適用できない
- resource limitを超える

未知の構文を無視したり、理解できた部分だけを実行したりする動作は行いません。
