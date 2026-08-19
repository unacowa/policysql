---
title: 認証とポリシー
description: Trusted sessionとrow・column policyの適用方法です。
---

# 認証とポリシー

PolicySQLは、検証済みJWTから構築したsessionを使って適用するpolicyを選択します。JWTの形式と検証規則は[JWT認証](./jwt)を参照してください。

## 認証からSessionまで

gatewayはJWTの署名、issuer、audience、有効期間とPolicySQL claimsを検証し、trusted sessionを構築します。

```json
{
  "role": "author",
  "variables": {
    "subject_id": "author_01"
  }
}
```

roleはJWTの`policysql.default_role`、または`policysql.roles`に含まれる`PolicySQL-Role`から選択されます。`subject_id`は標準`sub`から作られ、その他のsession variableは`policysql.session`から作られます。

## Policyの選択

policyは次の組み合わせで選択されます。

1. resource
2. role
3. operation

`posts`に対する`author`の`select` policyがなければ、そのSELECTは拒否されます。別roleのpolicyや、同じroleのupdate policyが代わりに使われることはありません。

## Row filter

row filterは、利用者のWHERE条件とは別に常に適用されます。

```yaml
filter:
  author_id:
    eq:
      session: subject_id
```

利用者がWHEREを省略しても、別のWHERE条件を指定しても、このauthor条件は維持されます。利用者のpredicateでpolicy predicateを置換、否定、弱化することはできません。

## Column permission

SELECT policyの`columns`には、client SQLから参照できるcolumnを列挙します。

```yaml
columns: [id, title, status]
```

許可の判定はprojectionだけではありません。WHEREなど、SQL内のすべてのclient由来expressionが対象です。

policy自身は、author filterのためにclientへ公開しない`author_id`を参照できます。このcolumnもcatalog上で存在と型が検証されますが、clientの許可columnには追加されません。

rowごとに値だけを非表示にするcolumnは、同じ`columns`内へ`name`、`visible_if`、`on_deny`を持つobjectとして定義します。この条件付き出力列は直接projectionだけに使用でき、predicateやsortによる推測を許可しません。

## Policy limit

policy limitはroleが一度に取得できる最大row数です。

```yaml
limit: 100
```

利用者のLIMITが100未満なら利用者の値、100を超えるか省略されていれば100が上限になります。

## エラーと情報開示

拒否エラーは、非公開column名、policy条件、他の利用者のdataを明らかにしない形式で返します。認証・認可の詳細は、client responseではなく、アクセス制限されたaudit logへ記録します。

## Defense in depth

PolicySQL以外にも次の対策を使用してください。

- database credentialへ必要最小限の権限だけを付与する
- JWTのissuer、audience、algorithmを固定して検証する
- JWTやsession claimをlogへ出力しない
- request timeoutとresult size limitを設定する
- tenantごとのdatabase分離を必要に応じて採用する
- policy・catalogのversionとrequest IDを監査ログへ保存する
- gatewayを迂回してdatabaseへ接続できる経路を制限する
