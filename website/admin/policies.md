---
title: ポリシー管理
description: Resource、role、operationごとのPolicySQL policyを定義します。
---

# ポリシー管理

Policy bundleは、resource、role、operationの順にaccess ruleを宣言します。policyに記載されていないアクセスは拒否されます。

正規のauthoring formatはresource-firstです。物理table名やdatabase配置はcatalogでresourceへ対応付け、policy fileには記載しません。

```text
resource -> role -> select | insert | update | delete
```

## Directory structure

policyはroot manifestとresource fileに分割します。一つのresourceに対するすべてのroleとoperationを同じfileへ配置します。

```text
policy/
├── policy.yaml
└── resources/
    ├── authors.yaml
    ├── comments.yaml
    └── posts.yaml
```

## Root manifest

`policy.yaml`はformat versionと読み込むresource fileを明示します。

```yaml
version: 1

includes:
  - resources/authors.yaml
  - resources/comments.yaml
  - resources/posts.yaml

commit_checks:
  post_consistency:
    triggered_by: [posts, comments]
    role: admin
    hook:
      url_env: POST_VALIDATOR_URL
      timeout_ms: 1500
      hmac_secret_env: POST_VALIDATOR_SECRET
```

include pathはpolicy rootからの相対pathです。fileの記載順によってpermissionの優先順位は変わりません。複数resourceにまたがる`commit_checks`はroot manifestへ定義します。

## Resource file

`resources/posts.yaml`は`posts`に対するpermissionをresource-firstで定義します。

```yaml
resource: posts

roles:
  author:
    select:
      columns:
        - id
        - title
        - status
        - published_at
        - name: private_note
          visible_if:
            author_id:
              eq:
                session: subject_id
          on_deny: null
      filter:
        author_id:
          eq:
            session: subject_id
      limit: 100
      allow_aggregations: false
      allow_windows: false

    insert:
      columns: [title, status]
      presets:
        author_id:
          session: subject_id
      check:
        author_id:
          eq:
            session: subject_id
      returning:
        columns: [id, title, status]

    update:
      columns: [title, status]
      filter:
        author_id:
          eq:
            session: subject_id
      check:
        author_id:
          eq:
            session: subject_id
      returning:
        columns:
          - id
          - title
          - status
          - name: private_note
            visible_if:
              author_id:
                eq:
                  session: subject_id
            on_deny: null

    delete:
      filter:
        author_id:
          eq:
            session: subject_id
      returning:
        columns: [id]
```

`resource: posts`はlogical resourceを指します。対応するbase tableとcolumnはcatalogから解決されます。resource fileに`table` fieldはありません。

## File loading rules

- `includes`はroot `policy.yaml`だけに指定できる
- absolute path、`..`、policy root外を指すsymlinkは拒否する
- glob、URL、環境変数をinclude pathに使用できない
- 同じresourceを複数fileで定義するとbundle全体を拒否する
- 一つのresourceをrole別やoperation別のfileへ分割できない
- YAML duplicate key、未知field、未登録fileを拒否する
- file順序による上書きやdeep mergeを行わない

すべてのfileをparse、catalog resolution、型検査してから、一つのimmutableなpolicy versionとして有効化します。一つでも失敗した場合は部分的に反映せず、直前の有効なversionを維持します。

配布物にはmachine-readableな`policy.schema.json`を含めます。editorやCIはJSON Schemaで構造、未知field、必須fieldを検査できます。columnの重複、Catalogとの整合、predicateの型、permission contextなど、複数箇所の情報を必要とする規則は`policysql policy validate`のsemantic validationで検査します。schema validationだけを有効化判定には使用しません。

## Policy selection

policyはresource、role、operationの組み合わせで選ばれます。たとえば`posts` resource fileの`roles.author.select`は次のrequestだけへ適用されます。

- resource: `posts`
- role: `author`
- operation: `select`

該当する要素がない場合はdenyです。空のpolicyや別roleのpolicyをfallbackとして扱いません。

## Role別の確認

保存形式をrole-firstにはしません。roleが利用できるresourceとoperationはinspection commandで確認します。

```bash
policysql policy inspect --root policy/policy.yaml --role author
```

```text
author
  authors
    select
  comments
    select, insert, delete
  posts
    select, insert, update, delete
```

resource変更時は一つのresource fileだけを修正でき、security reviewではrole別のeffective permissionを横断的に確認できます。

## Hasura metadataとの関係

row permission、column permission、role、session predicateの考え方はHasuraを参考にしていますが、file formatとdirectory layoutはPolicySQL独自です。Hasura metadataとのimport、export、merge互換性はありません。

## Columns

`columns`には、client SQLから参照または変更できるcolumnを明示します。通常列は文字列で記述します。

```yaml
columns: [id, title, status, published_at]
```

SELECTでは、SELECT list、WHERE、JOIN、ORDER BY、GROUP BY、HAVING、window、subqueryを含むすべてのclient由来expressionへ適用されます。

policyに使う内部columnをclientへ公開する必要はありません。例では`author_id`をrow filterに使用していますが、clientのSELECTやWHEREからは参照できません。

INSERTとUPDATEの入力`columns`は文字列だけを受け付けます。mutationの`returning.columns`は独立した出力許可一覧です。変更可能なcolumnでも、`returning`に含まれなければ返却できません。

## 条件付き出力列

rowとtrusted sessionに応じて値を表示または`null`化するcolumnは、通常列と同じ`columns`へ`name`付きobjectとして記述します。

```yaml
select:
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

`visible_if`がSQL TRUEの場合だけ元の値を返します。FALSEまたはUNKNOWNの場合はJSON `null`を返し、responseの`redactions`へ`POLICY_REDACTED`を記録します。元のdatabase値がNULLだった場合も、visibilityがdenyならredactionを記録します。

条件付き出力列はbase columnの直接projectionとaliasだけに使用できます。

```sql
-- 許可
SELECT id, private_note AS note FROM posts;

-- private_noteをpredicateに使うため拒否
SELECT id FROM posts WHERE private_note IS NOT NULL;

-- computed expressionに使うため拒否
SELECT lower(private_note) FROM posts;
```

同じcolumn名を文字列とobjectの両方へ記載するなど、`columns`内で名前が重複するとpolicy bundle全体を拒否します。条件適用の有無をclient SQLで選択したり、`visible_if`をclient predicateで変更したりすることはできません。

## Returning

mutationの`returning.columns`も同じ統合形式です。

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

`returning`を省略したoperationでは、client SQLの`RETURNING`を許可しません。`returning.columns`の条件付きobjectにも直接projection限定とredactionの規則を適用します。

## Filter

`filter`は、対象resourceへ常に適用するrow条件です。

session参照には、検証済みJWTから構築されたtrusted sessionのkeyを使用します。標準`sub`は`subject_id`、application固有値は`policysql.session`内の名前で参照します。

```yaml
filter:
  author_id:
    eq:
      session: subject_id
```

predicateは、一つのcolumn comparison、または一つの論理operatorで構成します。同じobjectへ複数のcolumnやoperatorを並べず、`and`または`or`の配列で結合します。

利用できるoperatorは次のとおりです。

- `eq`、`neq`
- `lt`、`lte`、`gt`、`gte`
- `in`、`not_in`
- `is_null`
- `like`
- `and`、`or`、`not`
- session value、literal value、same-row column value

未知のoperator、catalogにないcolumn、型が一致しないsession参照は、policy load時に拒否されます。

```yaml
filter:
  and:
    - status:
        in: [draft, published]
    - deleted_at:
        is_null: true
    - author_id:
        eq:
          session: subject_id
```

literalはscalarを直接指定するか、`literal`で明示できます。`eq: null`は許可せず、NULL判定には`is_null: true`または`is_null: false`を使用します。`in`と`not_in`は空でないliteral配列です。related-row predicateはこのversionのpolicy DSLには含めず、複数resourceの検証にはcommit checkを使用します。

## Limit

`limit`はSELECTが返却できる最大row数です。

```yaml
limit: 100
```

clientがより小さいLIMITを指定することはできますが、この値を超える指定やLIMITの省略によって上限を回避することはできません。

## Aggregation

```yaml
allow_aggregations: true
```

`allow_aggregations`はbooleanです。省略時と`false`では、aggregate function、`GROUP BY`、`HAVING`を拒否します。`true`の場合だけ、SELECT policyで許可されたcolumnに対する集約を利用できます。

```yaml
select:
  columns: [id, status, view_count]
  filter:
    author_id:
      eq:
        session: subject_id
  limit: 100
  allow_aggregations: true
```

column permissionは集約時にも変わりません。aggregate argument、`GROUP BY`、`HAVING`、`ORDER BY`で参照するcolumnは、すべて`columns`に含まれている必要があります。集約専用のcolumn allowlistはありません。

```sql
-- 許可対象
SELECT status, AVG(view_count)
FROM posts
GROUP BY status;

-- internal_notesがcolumnsにないため拒否
SELECT status, COUNT(*)
FROM posts
GROUP BY internal_notes;
```

利用できるaggregate functionはdeploymentのfunction allowlistとcolumn typeで決まります。未知のfunction、user-defined aggregate、型が合わないargumentは拒否されます。

row filterはaggregationより前に適用されます。この例では、`subject_id`に対応するauthorのrowだけが集約対象です。client predicateによってpolicy filterを置換したり、別authorのrowを集約したりすることはできません。

`limit`は返却するresult rowまたはgroupの上限であり、aggregateへの入力row数を切り詰めません。読み取り量と計算量は、database timeout、query cost、最大group数などdeploymentのresource limitで制御します。

## Window function

```yaml
allow_windows: true
```

`allow_windows`も省略時は`false`です。`true`の場合だけ、Capabilitiesで許可されたwindow functionを使用できます。window argument、`PARTITION BY`、window内の`ORDER BY`で参照するcolumnは文字列形式の`columns` itemに含まれている必要があります。条件付き出力列は使用できません。

## Preset

presetのformatは、INSERTまたはUPDATEの`presets`へserver-owned columnと値のsourceを指定します。

```yaml
presets:
  author_id:
    session: subject_id
```

詳細な動作と使用例は[書き込みの整合性](../sql/write-integrity#preset)を参照してください。

同じcolumnを`columns`と`presets`へ定義するpolicyは無効です。client SQLがpreset columnを指定した場合は、同じ値でも上書きせず拒否します。

## Check

checkのformatは、INSERTまたはUPDATEの`check`へ変更後のrowが満たすpredicateを指定します。

```yaml
check:
  author_id:
    eq:
      session: subject_id
```

filterとの違いとatomicな検証方法は[書き込みの整合性](../sql/write-integrity#operation-check)を参照してください。

## Commit check

commit checkのformatは、root manifestの`commit_checks`へtrigger resource、任意のrole、hook接続設定を指定します。

```yaml
commit_checks:
  post_consistency:
    triggered_by: [posts, comments]
    role: admin
    hook:
      url_env: POST_VALIDATOR_URL
      timeout_ms: 1500
      hmac_secret_env: POST_VALIDATOR_SECRET
```

機能の使い分けは[書き込みの整合性](../sql/write-integrity#commit-check)、callback query、role昇格、opaque capability、Transaction APIとの関係は[Commit check](../sql/commit-checks)を参照してください。

## Policy validationとversion

policyは有効化前に次の検証を通ります。

- document versionとschema
- 未知fieldと未知operator
- resource・columnのcatalog resolution
- `columns`を正規化したcolumn名が重複しないこと
- 条件付き出力列の`name`、`visible_if`、`on_deny`、projection contextを検証できること
- session参照の存在と型
- limitやtimeoutの範囲
- deployment capabilityとの整合性
- mutation checkをatomicに実行できること
- commit checkのtrigger resource、role、hook設定を解決できること

validationに失敗したdocumentは一切読み込まれません。更新はimmutableなversionとして公開され、一つのrequestは同じpolicy・catalog snapshotだけを使用します。
