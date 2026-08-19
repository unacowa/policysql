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

条件付きreturning columnは直接projectionだけに使用でき、visibilityがdenyなら値を`null`にしてredaction metadataを返します。`returning`を省略したoperationでは`RETURNING`を使用できません。

## Transaction

clientが`BEGIN`、`COMMIT`、`ROLLBACK`を送ることはできません。preset、validation、変更、post-state checkに必要なtransactionはPolicySQLが管理します。

複数のmutationをまとめる場合も[Atomic Execute API](../api/execute)の`statements[]`を使用します。単一SELECTや単一mutationと同じrequest shapeです。途中結果をapplicationで判断して次のSQLを組み立てる場合だけ[対話型Transaction API](../api/transactions)を使います。それぞれの`sql` fieldには一つのstatementだけを指定します。
