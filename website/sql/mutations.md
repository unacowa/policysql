---
title: データの追加・更新・削除
description: INSERT、UPDATE、DELETEとmutation policyを説明します。
---

# データの追加・更新・削除

PolicySQLは、policyで明示的に許可された`INSERT`、`UPDATE`、`DELETE`を受け付けます。column permission、row filter、preset、変更後のoperation check、transactionのcommit checkを一つの保護された処理として適用します。

preset、operation check、commit checkの役割と実行順序は[データ正常性](../data-validity/overview)と[書き込みの整合性](./write-integrity)を参照してください。

## INSERT

追加するcolumnを明示し、`VALUES`を使用します。

```sql
INSERT INTO posts (title, status)
VALUES (:title, :status)
RETURNING id, title, status;
```

policyで許可されていないcolumnは指定できません。`author_id`や`created_at`などのserver-owned columnはpresetから追加できます。

```yaml
insert:
  columns: [title, status]
  presets:
    author_id:
      session: subject_id
  check:
    author_id:
      eq:
        session: subject_id
```

clientがpreset columnを明示した場合は、値が同じでも拒否されます。

bytes型のcolumnには、INSERT／UPDATEとも固定base64 literalをpresetにできます。例えば`seed: { literal: "AAEC/w==" }`は`00 01 02 ff`のBLOBになります。policy読込み時にencodingと復号後サイズを検証し、server-owned parameterとしてbindします。session文字列のbytesへの暗黙変換、NULL preset、bytes literalを使ったpolicy比較は追加しません。

## UPDATE

UPDATE policyは、変更対象rowと変更可能columnを別々に制限します。

```sql
UPDATE posts
SET title = :title,
    status = :status
WHERE id = :id
RETURNING id, title, status;
```

```yaml
update:
  columns: [title, status]
  filter:
    author_id:
      eq:
        session: subject_id
  presets:
    updated_by:
      session: subject_id
  check:
    author_id:
      eq:
        session: subject_id
```

`filter`は変更前のrowを制限し、`check`は変更後のrowが満たす条件を定義します。変更とcheckはatomicに実行され、checkに失敗した場合は変更全体がrollbackされます。

複数rowを更新した場合は変更された全rowへcheckを適用し、FALSEまたはUNKNOWNが一つでもあれば全体をrollbackします。0 row更新はcheck成功として扱うため、更新件数も保証する場合はTransaction APIの`expect.affectedRows`を指定します。

## DELETE

DELETE policyのfilterに一致するrowだけを削除できます。

```sql
DELETE FROM posts
WHERE id = :id
RETURNING id;
```

```yaml
delete:
  filter:
    author_id:
      eq:
        session: subject_id
  returning:
    columns: [id]
```

## RETURNING

`RETURNING`には独立したcolumn permissionが適用されます。更新できるcolumnであっても、`returning.columns`に含まれていなければ指定できません。

```yaml
returning:
  columns:
    - id
    - title
    - name: private_note
      visible_if:
        author_id:
          eq:
            session: subject_id
      on_deny: null
```

Catalogで`nullable: true`と宣言された書込み可能列には、named parameterへJSON `null`を渡してSQL NULLを保存できます（例: `UPDATE nullabletexts SET state=:value WHERE id=:id RETURNING state`に`{"value": null}`）。そのparameterのすべての出現箇所がnullable列への直接代入である必要があり、WHERE、`IN`、関数、`LIMIT`などで再利用すると400 `POLICYSQL_INVALID_PARAMETER`になります。presetやserver-owned列、`columns`にない列は従来どおり書き込めません。`check`はNULLを書き込んだ後の行で評価され、`neq`や`not`などNULLでUNKNOWNになる条件は失敗します。

条件付きreturning columnは直接projectionだけに使用でき、visibilityがdenyなら値を`null`にしてredaction metadataを返します。`returning`を省略したoperationでは`RETURNING`を使用できません。

## Transaction

clientが`BEGIN`、`COMMIT`、`ROLLBACK`を送ることはできません。preset、validation、変更、post-state checkに必要なtransactionはPolicySQLが管理します。

複数のmutationをまとめる場合も[Atomic Execute API](../api/execute)の`statements[]`を使用します。単一SELECTや単一mutationと同じrequest shapeです。途中結果をapplicationで判断して次のSQLを組み立てる場合だけ[対話型Transaction API](../api/transactions)を使います。それぞれの`sql` fieldには一つのstatementだけを指定します。
