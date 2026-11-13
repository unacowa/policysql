---
title: 認証とポリシー
description: Trusted sessionとrow・column policyの適用方法です。
---

# 認証とポリシー

PolicySQLは、ラッパーが認証して渡したtrusted sessionを使って適用するpolicyを選択します。trusted sessionの形と、参考ラッパーが使うJWTの検証規則は[JWT認証](./jwt)を参照してください。

## 認証からSessionまで

ラッパーがcredentialを検証してtrusted sessionを作ります。参考ラッパーはJWT identity adapterでJWTの署名、issuer、audience、有効期間を検証し、PolicySQL claimsからsessionを作ります。PolicySQLのcoreはsessionの形を検証し、roleを選択して、次の値を使います。

```json
{
  "role": "author",
  "variables": {
    "subject_id": "author_01"
  }
}
```

roleはsessionの`defaultRole`（JWTでは`policysql.default_role`）、または`roles`に含まれる`PolicySQL-Role`から選択されます。`subject_id`はsessionの`subject`（JWTでは標準`sub`）から作られ、その他のsession variableは`session`（JWTでは`policysql.session`）から作られます。

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

利用者のLIMITが100未満なら利用者の値、100を超えるか省略されていれば100が上限になります。負のLIMITは受け付けません（400 `POLICYSQL_INVALID_PARAMETER`）。

## エラーと情報開示

拒否エラーは、非公開column名、policy条件、他の利用者のdataを明らかにしない形式で返します。認証・認可の詳細は、client responseではなく、アクセス制限されたaudit logへ記録します。

## 保証の範囲

PolicySQLが保証する性質（P1〜P5）の定義は[security model](https://github.com/unacowa/policysql/blob/main/docs/security-model.md#security-properties)にあります。概要は次のとおりです。

- SELECTの結果は、policyで見えるrowとcolumnだけから成るdatabaseに同じSQLを実行した結果と一致します（policy limitによる行数の上限を除きます）。
- INSERT／UPDATE／DELETEが変更するのは、policyの`filter`とclientの`WHERE`を満たすrowと、許可されたcolumnだけです。presetの値はclientのSQLや値では変わりません。
- mutationの結果（`RETURNING`、件数、checkの成否）から分かるのは、見えるrowの内容と、policyが公開を決めた範囲（`returning.columns`、`filter`と`check`の成否）だけです。ただし、update／delete policyの`filter`がselect policyの`filter`より広いと、その差のrowの値を推測できます（[operationごとのfilterの広さ](../admin/policies#operationごとのfilterの広さ)）。
- 集約とwindow関数は、文が読むすべてのresourceのselect policyが許可したときだけ使えます。

### 保証しないこと

次は保証の範囲外です。必要な場合は、PolicySQLの外で対策してください。

1. 応答時間、資源消費、応答サイズからの推測。
2. UNIQUE制約や外部キー制約のエラーからの、見えないrowの存在の推測。
3. clientの条件が見えないrowに対しても評価されることによる、エラーや時間差（SQLiteは`clientの条件 AND policyの条件`の評価順を保証しません）。
4. 許可された集約（`COUNT(*)`など）の結果からの推論。
5. policyの記述の誤り。policyは信頼された入力として扱います。
6. SQLiteとTursoの実装差や、PolicySQLが使うparserと実際のengineの構文解釈の差。
7. trigger、cascade、生成列、DEFAULTやrowidの採番など、PolicySQLのモデルの外にある副作用。
8. PolicySQL自身のテストや検査器の誤り。

## Defense in depth

PolicySQL以外にも次の対策を使用してください。

- database credentialへ必要最小限の権限だけを付与する
- JWTのissuer、audience、algorithmを固定して検証する
- JWTやsession claimをlogへ出力しない
- request timeoutとresult size limitを設定する
- tenantごとのdatabase分離を必要に応じて採用する
- policy・catalogのversionとrequest IDを監査ログへ保存する
- gatewayを迂回してdatabaseへ接続できる経路を制限する
