---
title: SELECT
description: PolicySQLで利用できるSELECT文とpolicy適用規則です。
---

# SELECT

PolicySQLは、catalog上でtableとcolumnの出所を解決でき、すべての参照へpolicyを適用できるSELECTを受け付けます。

## 基本形

```sql
SELECT p.id, p.title, a.name AS author_name
FROM posts AS p
JOIN authors AS a ON a.id = p.author_id
WHERE p.status = :status
ORDER BY p.published_at DESC
LIMIT :limit;
```

## 複数SELECTの実行

SELECTの標準requestは、1件以上を受け付ける`statements[]`です。複数のSELECTを配列へ並べると、同じread transactionとpolicy/Catalog snapshotで順番に実行します。

```json
{
  "statements": [
    {
      "sql": "SELECT id, title FROM posts WHERE status = :status LIMIT :limit",
      "params": { "status": "published", "limit": 20 }
    },
    {
      "sql": "SELECT id, name FROM authors WHERE id = :author_id",
      "params": { "author_id": "author_01" }
    }
  ]
}
```

responseの`results[0]`は`statements[0]`、`results[1]`は`statements[1]`に対応します。SELECTが1件の場合もscalar bodyにはせず、同じ配列を1要素で使用します。

各`statements[].sql`に指定できるのは一つのstatementだけです。末尾のsemicolonは使用できますが、同じ`sql` fieldへ別のstatementを続けることはできません。

## SELECTする列

取得する列または式を明示します。

```sql
SELECT id, title, status
FROM posts;
```

column aliasも使用できます。

```sql
SELECT title AS post_title
FROM posts;
```

alias適用後の結果column名は、SQLiteのASCII case-insensitive比較で一意でなければなりません。`id`と`ID`も衝突として扱います。

```sql
-- 二つのresult columnがidになるため拒否
SELECT posts.id, authors.id
FROM posts
JOIN authors ON authors.id = posts.author_id;

-- 一意なaliasを指定すれば許可
SELECT posts.id AS post_id, authors.id AS author_id
FROM posts
JOIN authors ON authors.id = posts.author_id;
```

空のaliasと重複aliasはdatabaseへ送信する前に拒否されます。これによりJSON rowのkeyと`redactions[].column`を一意に対応付けられます。

`SELECT *`と`table.*`は使用できません。返却する列を明示することで、schema変更によって非公開列が結果へ加わることを防ぎます。

## JOIN

catalogで両resourceとJOIN columnの出所を解決できるJOINを使用できます。

```sql
SELECT p.id, p.title, a.name AS author_name
FROM posts AS p
JOIN authors AS a ON a.id = p.author_id;
```

各base tableには、それぞれのresource policyが適用されます。`posts`だけが許可されていても、`authors`のSELECT policyがなければこのSQLは拒否されます。

`INNER JOIN`と`LEFT JOIN`を利用できます。outer joinでは、結果の意味を変えない位置へrow filterが適用されます。利用可能な追加join typeは[Capabilities](../reference/catalog-and-capabilities)で確認できます。

## WHERE

許可されたcolumn、literal、parameter、同じrowのcolumnを使ったboolean expressionを指定できます。

| 分類 | Operator |
| --- | --- |
| 比較 | `=`、`!=`、`<>`、`<`、`<=`、`>`、`>=` |
| 集合 | `IN`、`NOT IN` |
| NULL | `IS NULL`、`IS NOT NULL` |
| 論理 | `AND`、`OR`、`NOT` |
| 文字列 | `LIKE`、`GLOB` |

```sql
SELECT id, title
FROM posts
WHERE status = :status
  AND (title LIKE :prefix OR published_at >= :since);
```

clientのWHERE条件とは別に、policyのrow filterが常に適用されます。

## SubqueryとCTE

columnの出所とpolicy適用先を完全に解決できる、Capabilities掲載のclosed formを使用できます。SQLite profileでは、明示列だけをそのまま公開する単一base resourceのtransparent derived table、修飾済みcorrelated `EXISTS`、単一のtransparentまたはfiltered非recursive CTE（外側で通常のJOINが可能）を受け付けます。`EXISTS`の内側projectionは、許可された直接columnまたは意味を結果へ公開しない正確な`SELECT 1`だけです。複数CTE、CTE内JOIN・集約・ORDER/LIMIT、scalar subquery、compound SELECTは受け付けません。

```sql
WITH published_posts AS (
  SELECT id, author_id, title
  FROM posts
  WHERE status = :status
)
SELECT p.id, p.title, a.name
FROM published_posts AS p
JOIN authors AS a ON a.id = p.author_id;
```

Correlated subqueryから外側queryを参照する場合は、`p.id`のようにtable aliasで修飾したcolumnを使用します。CTEやaliasによるshadowing、曖昧なcolumn、outer SELECT aliasを使ったcorrelationは拒否されます。recursive CTEはpublic endpointでは使用できません。

### Protected tableのshadowing

catalogに保護対象の`posts`が登録されている場合、同じ名前のCTEは使用できません。

```sql
WITH posts AS (
  SELECT id, title
  FROM archived_posts
)
SELECT id, title
FROM posts;
```

SQLiteでは後続の`FROM posts`がCTEを指しますが、PolicySQLはbase tableとCTEの取り違えを防ぐため拒否します。衝突しないCTE名を使用してください。

```sql
WITH archived AS (
  SELECT id, title
  FROM archived_posts
)
SELECT id, title
FROM archived;
```

### 曖昧なcolumn

参照可能なtableが同名columnを持つ場合、修飾されていないcolumnは拒否されます。

```sql
SELECT id, name
FROM posts
JOIN authors ON authors.id = posts.author_id;
```

この例の`id`は`posts.id`と`authors.id`のどちらを指すか一意に決まりません。次のように参照元を明示します。

```sql
SELECT posts.id, authors.name
FROM posts
JOIN authors ON authors.id = posts.author_id;
```

### Correlated subqueryのalias shadowing

内側queryで外側queryと同じaliasを再定義することはできません。

```sql
SELECT p.id
FROM posts AS p
WHERE EXISTS (
  SELECT 1
  FROM comments AS p
  WHERE p.post_id = p.id
);
```

内側の`comments AS p`が外側の`posts AS p`をshadowするため、見た目に反して両方の`p`が`comments`を指します。query scopeごとに異なるaliasを使用します。

```sql
SELECT p.id
FROM posts AS p
WHERE EXISTS (
  SELECT 1
  FROM comments AS c
  WHERE c.post_id = p.id
);
```

この修正版では、`c.post_id`が`comments`、`p.id`が外側の`posts`に由来すると一意に追跡できます。

### Outer SELECT aliasによるcorrelation

外側queryのSELECT aliasをsubqueryから参照する形式は使用できません。

```sql
SELECT p.id AS post_key
FROM posts AS p
WHERE EXISTS (
  SELECT 1
  FROM comments AS c
  WHERE c.post_id = post_key
);
```

SELECT aliasの可視範囲に依存せず、外側tableの修飾済みcolumnを直接参照してください。

```sql
SELECT p.id AS post_key
FROM posts AS p
WHERE EXISTS (
  SELECT 1
  FROM comments AS c
  WHERE c.post_id = p.id
);
```

### Recursive CTE

recursive CTEは、columnの出所を解決できる場合でもpublic endpointの対応範囲外です。

```sql
WITH RECURSIVE descendants(id) AS (
  SELECT :root_id

  UNION ALL

  SELECT c.id
  FROM comments AS c
  JOIN descendants AS d ON c.parent_id = d.id
)
SELECT id
FROM descendants;
```

## ORDER BY

許可されたcolumnまたはSELECT結果のaliasで並び替えられます。

```sql
SELECT id, title, published_at
FROM posts
WHERE status = :status
ORDER BY published_at DESC, id ASC
LIMIT :limit;
```

返却しないcolumnをORDER BYへ指定する場合も、そのcolumnの参照権限が必要です。

## 集約とGROUP BY

policyで`allow_aggregations: true`が設定され、使用するcolumnとfunctionが許可されている場合に利用できます。省略時と`false`では、aggregate function、`GROUP BY`、`HAVING`を使用できません。

```sql
SELECT status, COUNT(*) AS post_count
FROM posts
GROUP BY status
HAVING COUNT(*) >= :minimum
ORDER BY post_count DESC;
```

row filterを適用した後のrowだけが集約対象になります。SELECT policyのcolumn permissionは、aggregate argument、`GROUP BY`、`HAVING`、`ORDER BY`にも同じように適用されます。禁止columnは結果へ返さない場合も参照できません。

policyの`limit`は返却するresult rowまたはgroupの上限です。aggregateへの入力rowをlimit件へ切り詰めるものではありません。読み取り量、最大group数、実行時間にはdeploymentのresource limitが適用されます。

## Window function

Capabilitiesでwindow functionが利用可能で、SELECT policyに`allow_windows: true`がある場合に利用できます。省略時と`false`ではすべてのwindow functionを拒否します。

```sql
SELECT id,
       title,
       ROW_NUMBER() OVER (
         PARTITION BY author_id
         ORDER BY published_at DESC
       ) AS author_post_number
FROM posts;
```

`PARTITION BY`と`ORDER BY`で参照するcolumnにもpermissionが必要です。

## FunctionとJSON

deploymentのallowlistに含まれ、型signature、nullable規則、volatilityが登録されたside-effect-free SQLite functionだけを利用できます。JSON function、日付function、文字列functionなどの具体的な一覧はCapabilitiesで確認します。

式projectionでは、Capabilitiesに掲載されたfunctionに加えて、型が一意に決まるsearched `CASE`、string同士の`||`、`CAST(... AS TEXT)`を使用できます。direct column以外の式には明示aliasが必要です。`CASE`の全result branchは同じlogical typeでなければならず、simple CASE、別型へのCAST、算術・bit演算は現在のSQLite profileでは拒否します。

```sql
SELECT CASE WHEN status = :status
            THEN CAST(title AS TEXT)
            ELSE title || :suffix
       END AS display_title
FROM posts;
```

user-defined function、extension function、side effectを持つfunctionは使用できません。

## LIMITとOFFSET

LIMITとOFFSETには、0以上のinteger literalまたはparameterを指定できます。

```sql
SELECT id, title
FROM posts
ORDER BY published_at DESC
LIMIT :limit OFFSET :offset;
```

policy limitとdeployment limitがある場合は、最も小さい値が実効上限になります。負数、実数、文字列、NULLは受け付けません。

## Column permission

禁止されたcolumnは、結果に返さない場所でも参照できません。WHERE、JOIN、ORDER BY、GROUP BY、HAVING、window、subqueryのすべてが検査対象です。

```sql
-- internal_notesが許可されていない場合は拒否される
SELECT id
FROM posts
WHERE internal_notes IS NOT NULL;
```

## Policy nullable column

policyの`columns`へ条件付きobjectとして定義されたcolumnは、rowを返したまま、`visible_if`に応じて投影値だけを`null`化できます。

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

条件付き出力列はbase columnの直接projectionと任意のaliasだけに使用できます。

```sql
SELECT id, private_note AS note
FROM posts;
```

`visible_if`は各rowで評価され、TRUEだけが表示を許可します。FALSEとUNKNOWNは`null`を返し、cell単位のredaction metadataを生成します。

条件付き出力列をWHERE、JOIN、ORDER BY、GROUP BY、HAVING、aggregate、window、function、subquery条件、CTEやderived tableを経由したprojectionで使用するSQLは拒否されます。値を直接返さなくても、結果の有無や順序から推測できるためです。

## 拒否される例

```sql
-- wildcard projection
SELECT * FROM posts;

-- multiple statements
SELECT id FROM posts; DELETE FROM posts;

-- recursive CTE
WITH RECURSIVE sequence(value) AS (...)
SELECT value FROM sequence;

-- allowlistにないfunction
SELECT custom_function(title) FROM posts;

-- duplicate result name
SELECT posts.id, authors.id
FROM posts JOIN authors ON authors.id = posts.author_id;

-- 条件付き出力列をpredicateに使用
SELECT id FROM posts WHERE private_note IS NOT NULL;
```
