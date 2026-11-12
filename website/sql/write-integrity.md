---
title: 書き込みの整合性
description: Preset、operation check、commit checkでmutationとtransactionの整合性を検証します。
---

# 書き込みの整合性

PolicySQLはpreset、operation check、commit checkを組み合わせ、mutationとtransactionの結果がapplicationの不変条件を満たすようにします。

このページは[データ正常性](../data-validity/overview)のうち、rowとtransactionの書き込み保証を扱います。単一値のlogical type、format、constraintは[型・フォーマット・制約](../data-validity/types-and-formats)を参照してください。

ここでいう整合性は、書き込む値と変更後のrowがpolicyで定義した条件を満たすことです。databaseのbackup、replication、durabilityを指すものではありません。

## 三つの機能

| 機能 | 実行時点 | 主な用途 |
| --- | --- | --- |
| `preset` | client入力の検証後、database実行の前 | 所有者、tenant、更新者などserver-owned値の設定 |
| operation `check` | 各mutationの実行後 | 変更されたrowが満たすべき不変条件の検証 |
| `commit_checks` | 全statement終了後、commit直前 | 複数resourceを含むtransaction全体の外部検証 |

処理順序は次のとおりです。

```text
permissionとfilter
  -> client inputの型検査
  -> preset
  -> INSERTまたはUPDATE
  -> operation check
  -> 全statement終了
  -> commit checks
  -> commit
```

いずれかが失敗するとtransactionは成功しません。database変更後にcheckが失敗した場合は、同じtransaction内で変更全体をrollbackします。

## Preset

presetは、clientに決めさせないcolumn値をPolicySQLが設定する機能です。

```yaml
insert:
  columns: [title, status]
  presets:
    author_id:
      session: subject_id
    tenant_id:
      session: tenant_id
```

clientが送信できるのは`title`と`status`だけです。`author_id`と`tenant_id`はtrusted sessionから設定されます。

```sql
INSERT INTO posts (title, status)
VALUES (:title, :status);
```

clientがpreset対象columnを明示した場合は、同じ値でも拒否します。

```sql
-- author_idはpreset対象なので拒否
INSERT INTO posts (title, status, author_id)
VALUES (:title, :status, :author_id);
```

UPDATEでも、変更者などのserver-owned値を設定できます。

```yaml
update:
  columns: [title, status]
  presets:
    updated_by:
      session: subject_id
```

presetは入力値を黙って上書きするdefault値ではありません。client-owned columnとserver-owned columnの境界を強制する機能です。

### サーバーの時刻（now）

`now: {}`は、PolicySQLがcompileした時刻をpreset値にします。作成日時や更新日時を、clientの時計に頼らず記録できます。

```yaml
insert:
  columns: [title, status]
  presets:
    author_id:
      session: subject_id
    created_at:
      now: {}
update:
  columns: [title, status]
  presets:
    updated_by:
      session: subject_id
    updated_at:
      now: {}
```

生成されるSQLでは、時刻はserver-owned parameterとして渡されます。SQLの文面に時刻は入りません。

```sql
UPDATE "posts" SET "title" = :title, "updated_by" = :__policysql_session_subject_id, "updated_at" = :__policysql_now_rfc3339 WHERE ...
```

値の形は、columnのCatalog上の型で決まります。

| Catalogの型 | 値の例（UTC） |
| --- | --- |
| `instant`（format `rfc3339`） | `2026-10-30T13:14:56.789Z` |
| `datetime`（format `sqlite-datetime`） | `2026-10-30 13:14:56`（SQLiteの`CURRENT_TIMESTAMP`と同じ形。ミリ秒は切り捨て） |
| `int64`、`integer` | `1793366096789`（epochミリ秒） |

これ以外の型のcolumnには`now`を使えず、policyを有効化できません。`string` columnに使うには、Catalogでcolumnを`instant`か`datetime`にします。`constraints`を付けたcolumnにも使えません。constraintが時刻を受け付けるかどうかは時刻しだいで、有効化の時点では決められないためです。

- **誰の時計か**: PolicySQLを動かすサーバー（Cloudflareでは、WorkerとDurable Object）の時計です。databaseの時計ではありません。
- **揃い方**: 1回のAtomic Executeの全statement・全行で同じ値です。対話型transactionは、statementごとに、そのstatementを処理したときの時刻です。同じ値が要る書き込みは、1つのAtomic Executeにまとめます。
- **再送**: `Idempotency-Key`付きの再送で、最初の実行がcommit済みなら、保存した応答（最初の時刻）を返します。commitされていなければ、新しい時刻で実行します。
- **注意**: 分解能はミリ秒で、`datetime`は秒に切り捨てます。サーバーの時計は単調とは限らないので、同じrowを続けて更新したとき、値が戻ることがあります。`filter`、`check`、`visible_if`では使えません。
- **使わない方法**: wrapperがsessionに時刻を入れて`session:`で書く方法は使えません。要求ごとに変わる値がsessionに入ると、`Idempotency-Key`付きの再送が別の要求になります。databaseのtriggerで書く方法は、`RETURNING`に反映されません。

同じoperationの`columns`と`presets`に同じcolumnを定義したpolicyは有効化できません。client SQLにpreset columnが現れた場合も、値を比較せず`POLICYSQL_PRESET_COLUMN`で拒否します。

## Operation check

checkは、INSERTまたはUPDATEによる変更後のrowが満たすべき条件です。

```yaml
insert:
  columns: [title, status]
  presets:
    author_id:
      session: subject_id
    tenant_id:
      session: tenant_id
  check:
    and:
      - author_id:
          eq:
            session: subject_id
      - tenant_id:
          eq:
            session: tenant_id
```

INSERTでは、presetを含む追加後の各rowへcheckを適用します。一つでも条件を満たさなければINSERT全体をrollbackします。

checkはSQL TRUEの場合だけ成功します。FALSEとUNKNOWNは失敗です。複数row mutationでは、変更された全rowがTRUEであることを同じtransaction内で検証します。対象rowが0件ならcheckはvacuously trueですが、1件の変更を要求する場合はTransaction APIの`expect.affectedRows`を併用します。

UPDATEでは、変更対象を選ぶ`filter`と、変更後を検証する`check`を分けます。

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
    and:
      - author_id:
          eq:
            session: subject_id
      - tenant_id:
          eq:
            session: tenant_id
```

- `filter`は変更してよい既存rowを選ぶ
- `check`は変更された各rowのpost-stateを検証する

operation checkが参照できるのは、そのmutation対象resourceの変更後row、literal、trusted sessionだけです。別rowの検索、別resource、aggregate、subquery、外部codeが必要な規則はcommit checkへ定義します。

DELETEには変更後のrowがないためcheckを使用しません。削除できる既存rowはdelete policyの`filter`で制限します。

## Commit check

commit checkは全statement終了後、commit直前に外部serviceを呼び出します。validatorはPolicySQLを介し、同じtransactionで必要なSELECTを実行できます。

```yaml
commit_checks:
  post_consistency:
    triggered_by: [posts, comments]
    role: admin
    hook:
      timeout_ms: 1500
```

roleを省略するとrequest実行者のroleを引き継ぎます。明示したroleはpolicyが付与するsystem privilegeであり、実行者JWTのallowed rolesとは独立しています。

複数resourceの集計、変更対象外resourceとの照合、application codeによる複雑な判定に使用します。callback query、role、opaque capability、Transaction APIとの関係は[Commit check](./commit-checks)を参照してください。

## 組み合わせ

resource fileでは、各mutationのpresetとoperation checkを定義します。

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
    and:
      - author_id:
          eq:
            session: subject_id
      - tenant_id:
          eq:
            session: tenant_id
```

root `policy.yaml`では、複数resourceにまたがるcommit checkを定義します。

```yaml
commit_checks:
  post_consistency:
    triggered_by: [posts, comments]
    role: admin
    hook:
      timeout_ms: 1500
```

presetやoperation checkが成功してもcommit checkは省略されません。各機能は異なる境界を検証し、一つの成功を別の機能の成功として扱いません。

## Database constraintとの関係

PolicySQLのcheckは、public SQL APIを通るrequestに対するapplication policyです。`NOT NULL`、`UNIQUE`、`FOREIGN KEY`、`CHECK`など、database自身が保証できる不変条件はdatabase constraintでも定義してください。

gatewayを経由しない書き込み、運用tool、migration、障害時の誤操作に対してはPolicySQL policyが適用されないため、重要なdata integrityをpolicyだけに依存させないでください。
