# PolicySQLテスト計画

## 1. 目的

PolicySQLの最重要セキュリティ保証は、公開されたSQL surfaceのすべてについて、入力SQLが正しく拒否されるか、ポリシーを保持したVerified Execution Planだけへ変換されることを反復可能に証明することである。

テストの中心単位を次のペアとする。

```text
入力bundle
  schema + Catalog manifest + policy + trusted session + client SQL + parameters
                                │
                                ▼
期待結果
  allow: verified plan + 実際にDBへ送られるprotected SQL + expected result
  deny:  stable error + rejection stage + executor未呼び出し証明
```

単なるSQL文字列のgolden比較ではなく、再parse・再bindした意味、アクセスしたResourceId / ColumnId、適用policy、parameter所有権、result descriptor、実行結果を検証する。

## 2. 「全SQLケース」の定義

SQL文字列は無限に存在するため、文字列を全列挙することはできない。本計画における完全coverageとは、各Backend Profileが公開するSQL grammarと意味判断を有限のequivalence classへ分割し、次のすべてを台帳化してfixtureへ対応付けることをいう。

1. parserが返し得るstatement種別とsecurity-relevant AST node;
2. advertiseするstatement、clause、table source、expression、operator、functionの各形状;
3. 常に拒否する形状と拒否stage;
4. identifier、scope、alias、CTE、correlation、column provenanceの各判断;
5. column usage context: projection、filter、join、order、group、having、aggregate、window、mutation、write、returning;
6. policy分岐: policy有無、regular column、conditional output、row filter、limit、全JOIN resource policy、aggregation boolean gate、window boolean gate、preset、check、returning;
7. parameter所有権、logical type、NULL、result identity、resource limitの境界値;
8. dialect / engine差分とBackend Profile不一致;
9. security modelに列挙されたbypass threat;
10. accepted node同士の高リスクな組み合わせ。

全組み合わせの直積は作らない。各単独classを100% coverし、組み合わせはpairwise coverageを基本とする。ただし、policy placement、scope/provenance、parameter ownership、mutation atomicity、profile mismatchは脅威ベースで明示した高リスク組み合わせを全件fixture化する。

## 3. Coverage台帳

profileごとにmachine-readableなSQL surface台帳を置く。

```text
tests/sql-surface/
  common.yaml
  sqlite-v1.yaml
  turso-v1.yaml
  postgres-v1.yaml       # 将来。advertisedになるまで全項目disabled
  threats.yaml
```

各leafには不変なIDを付ける。

```yaml
id: sqlite.select.where.binary.eq
profile: sqlite-turso-v1
kind: expression
status: advertised
contexts: [filter]
required_tests: [positive, negative, bypass, differential]
```

代表的なID namespaceは次のとおりとする。

| Namespace | 対象 |
| --- | --- |
| `envelope.*` | 空配列、複数item、statement count、parameter envelope |
| `statement.*` | SELECT、INSERT、UPDATE、DELETE、常時拒否statement |
| `source.*` | base table、alias、join、CTE、derived table、subquery |
| `expression.*` | literal、parameter、column、boolean、comparison、function |
| `clause.*` | projection、WHERE、ORDER、LIMIT、GROUP、HAVING、WINDOW、RETURNING |
| `binding.*` | unknown、ambiguous、shadowing、correlation、provenance |
| `policy.*` | selection、row filter、column、limit、preset、check、redaction |
| `policy.join.*` | 全resource policy、JOIN column permission、outer-join placement |
| `policy.aggregate.*` | `allow_aggregations` gate、aggregate/GROUP BY/HAVING column permission |
| `policy.window.*` | `allow_windows` gate、PARTITION BY/window ORDER BY column permission |
| `emission.*` | parameter namespace、join placement、determinism、reparse |
| `result.*` | name、logical type、nullability、redaction、runtime codec |
| `transaction.*` | atomicity、idempotency、retry、commit check、owner loss |
| `profile.*` | dialect、capability、version、plan/executor mismatch |
| `threat.*` | security-model.mdの明示的脅威 |

### Coverage gate

`policysql-testkit`へ`coverage-check`を実装し、CIで次を失敗条件にする。

- fixtureの実行結果から生成されたdigest付きcoverage evidenceがない、古い、またはcaseが不足する;
- `case.yaml`の`tests`自己申告だけでcoverageを満たそうとする;
- 台帳のadvertised leafに必要なfixture種別が1つでもない;
- fixtureが存在しないcoverage IDを参照する;
- 同じcase IDが重複する;
- deny fixtureにstable errorまたはrejection stageがない;
- allow fixtureにprotected SQL、verified-plan assertion、expected resultがない;
- bypass fixtureに攻撃目的と守るinvariantがない;
- differential対象がreference SQLiteまたはadvertised engineで走っていない;
- parser dependency更新後に未分類のsecurity-relevant AST variantがある;
- capabilityがfixtureより先にadvertisedへ変更された;
- deployment capabilityが必要なresource/column policyまたはaggregate/window gateなしに実行を許可する;
- profile固有fixtureが別profileのplanを受理する。

coverage reportは人間がreviewしやすいMarkdownとCI用JSONの両方を生成する。

```text
target/policysql-test-coverage/
  sqlite-turso-v1.md
  sqlite-turso-v1.json
  uncovered.json
```

reportは最低でも`coverage ID → fixture ID → test level → result`を一覧表示する。

fixture matrixは先にpositive compile、negative/bypassのzero-egress、protected SQL、reference SQLite differentialを実行し、すべて成功した場合だけ`executed-fixtures.json`を生成する。`coverage-check`は各fixture directoryの内容digestを再計算し、実行証跡と一致したtest classだけをcoverageへ算入する。

## 4. Fixture pair形式

fixtureは1 directoryで完結させ、他fixtureのmutable stateを共有しない。

```text
tests/fixtures/sqlite-turso-v1/
  select/where/eq-client-and-policy/
    case.yaml
    schema.sql
    catalog-manifest.yaml
    policy.yaml
    session.json
    input.sql
    client-params.json
    seed.sql
    expected/
      protected.sql
      plan.yaml
      result.json
      explain.json
```

拒否caseは次の形とする。

```text
  select/bypass/forbidden-column-order/
    case.yaml
    schema.sql
    catalog-manifest.yaml
    policy.yaml
    session.json
    input.sql
    client-params.json
    expected/
      rejection.yaml
```

### case.yaml

```yaml
id: sqlite.select.where.eq-client-and-policy
profile: sqlite-turso-v1
description: caller predicateとtenant policyをANDで合成する
covers:
  - statement.select.single-table
  - clause.where
  - expression.binary.eq
  - policy.select.row-filter
  - emission.server-parameter
  - threat.row-policy-replacement
tests: [positive, bypass, differential]
expected: allow
```

`covers`は自由記述にせず、Coverage台帳のIDだけを許可する。

### expected/protected.sql

実際にDBへ送信されるべきSQLをreview可能な形で保存する。whitespaceやcompiler-owned aliasだけを理由にテストを壊さないよう、合否は次の順序で判定する。

1. protected SQLを再parseできる;
2. 厳密に1 statementである;
3. 独立binderが期待するResourceId / ColumnId / usage setへ解決する;
4. `expected/plan.yaml`のpolicy predicate、join placement、limit、parameter ownershipと一致する;
5. canonical emitter出力とgoldenが一致する。

1〜4をsecurity assertion、5をreviewabilityとdeterminismのassertionとして扱う。golden更新だけで1〜4を回避できないようにする。

### expected/plan.yaml

最低限、次を保持する。

```yaml
operation: select
resources: [resource.posts]
accesses:
  - { column: posts.id, usage: projection }
  - { column: posts.status, usage: filter }
  - { column: posts.tenant_id, usage: policy_filter }
policies: [author.posts.select]
client_parameters: [status]
server_parameters: [session.tenant_id]
effective_limit: 100
result:
  - { name: id, type: string, nullable: false }
```

SQL textからこのファイルを生成して自己確認してはならない。compilerとは独立した期待値としてreviewする。

### expected/rejection.yaml

```yaml
stage: authorization
code: POLICYSQL_FORBIDDEN_COLUMN
executor_calls: 0
public_message_contains_hidden_identifier: false
```

deny fixtureはrecording executorを使用し、DB adapterが一度も呼ばれていないことを必ずassertする。

## 5. 1 SQL caseに必要な4分類

新しいaccepted SQL featureには原則として次の4 fixtureを要求する。

| 分類 | 目的 | 例 |
| --- | --- | --- |
| positive | 許可された最小形が正しくcompileされる | allowed columnの`WHERE status = :status` |
| negative | 不正・未許可・曖昧な形を拒否する | unknown column、型不一致、missing policy |
| bypass | policyを弱める攻撃形を拒否または安全に変換する | forbidden columnを`ORDER BY`で推測 |
| differential | compilerの意味がreference engineと一致する | input oracleとprotected SQLの行集合比較 |

単一fixtureが複数分類を満たすことはできるが、coverage reportでは分類ごとの根拠を表示する。

## 6. 初期SQLite SELECT coverage matrix

最初のvertical sliceで最低限coverするequivalence classを以下とする。

### Requestとstatement境界

- 1 item / 複数ordered item;
- 空SQL、whitespace、commentのみ;
- 1 statement、semicolon終端、2 statement、commentを使ったstatement smuggling;
- SELECT以外の全statement family;
- named parameterのみ、positional parameter、未使用parameter、不足parameter、重複key;
- clientによる`__policysql_` namespace使用;
- statement数、parameter数、SQL bytesの最小・最大・超過。

### SELECT形状

- explicit column 1件 / 複数件 / qualified / alias付き;
- `*`、`table.*`、空または重複result name;
- single base table、table alias、unknown table、qualified database name;
- WHEREなし / simple boolean predicateあり;
- parentheses、`AND`、`OR`、`NOT`、比較operator、`IS NULL`;
- literalとnamed parameter;
- LIMITなし / literal / parameter / 0 / policy未満 / 同値 / policy超過 / 負値;
- OFFSETはcapabilityがadvertisedされるまで明示deny;
- ORDER BY、JOIN、subquery、CTE、GROUP、HAVING、WINDOW、functionは初期sliceで明示denyし、後続milestoneで個別にadvertisedへ変更。

### Bindingとprovenance

- known / unknown column;
- unqualified columnが一意 / 曖昧;
- quoted identifierとASCII case差;
- alias参照、duplicate alias、alias shadowing;
- implicit `rowid`、`_rowid_`、`oid`;
- forbidden columnをprojection、filter、order、join、group、having、function、subqueryへ置く各case;
- conditional output columnのdirect projection / alias projection / それ以外の全usage context。

### Policy

- role、resource、operation policyが存在 / 欠落;
- caller predicateなし / あり;
- caller predicateがpolicyと矛盾、OR、NOT、常時TRUE、NULLを含む;
- policy filterがSQL TRUE / FALSE / UNKNOWNとなるseed row;
- regular allowed column / forbidden column / conditional output column;
- caller limitなし / policy limitなし / 両方あり;
- server session値のdescriptor互換 / 非互換;
- reserved session key、client/server parameter衝突;
- immutable snapshot version一致 / stale。

### Emissionとsecond-pass verifier

- client predicateとpolicy predicateのAND構造;
- server parameterの名前と所有権;
- expected resource / column access set;
- policy predicateを削除したnegative control;
- forbidden projectionを追加したnegative control;
- statementを追加したnegative control;
- parameterをclient namespaceへ移したnegative control;
- emitter出力のparse failure;
- emitterとverifierのprofile mismatch;
- 同一入力・snapshotからのdeterministic output。

### Resultとresource bound

- result nameの非空・一意性;
- logical type、nullability、representation;
- visible database NULLとpolicy redaction NULLの区別;
- runtime storage classがdescriptorと一致 / 不一致;
- row limit、result byte limit、timeout;
- errorにhidden schema、policy ID、protected SQL、raw DB messageが含まれない。

## 7. 後続SQL surface

後続featureは次の順序で台帳の`disabled`から`advertised`へ移す。

1. `ORDER BY`;
2. `INNER JOIN`;
3. `LEFT JOIN`とnull-extension boundary;
4. non-recursive CTE、derived table、subquery、correlation;
5. aggregation、GROUP、HAVING;
6. windowとregistered function;
7. `INSERT ... VALUES`;
8. DELETE;
9. UPDATE;
10. RETURNING、preset、post-state operation check;
11. atomic multi-statement、interactive transaction、commit check。

各段階で、追加nodeだけでなく既存nodeとの高リスクな組み合わせを追加する。特にLEFT JOINはpolicy predicateのON / WHERE配置、mutationはwriteとpost-state checkのatomicity、RETURNINGは独立column permissionを必須caseとする。

JOIN、GROUP/HAVING、windowをadvertisedへ移す前に、deployment capabilityだけでなく全resource/column permissionとaggregate/window boolean gateをfixture化する。

- JOINは、すべてのbase resourceにselect policyがあり、ONを含む全参照columnがregular `columns`に含まれる場合だけ通ることを検証する。resource policy欠落またはcolumn permission欠落はdenyかつexecutor call 0。
- LEFT JOINは、nullable側resourceのpolicy predicateが`ON`に配置され、root側predicateが`WHERE`に配置されることをprotected SQLとreference differentialで検証する。
- GROUP BYは、`aggregations.group_by`に列挙されたcolumnだけが使えることを検証する。projection可能columnであってもgroup allowlistにないcolumnはdenyかつexecutor call 0。
- HAVINGは、`aggregations.having.columns`と`aggregations.having.aggregates`の両方を検証する。
- aggregate functionは、明示されたfunctionだけを許可する。初期は`COUNT(*)`のみをportable allow targetとする。
- windowは、function、`PARTITION BY` column、window `ORDER BY` columnを個別に検証する。
- Cloudflare / Turso egress E2Eでは、allow caseはHTTP入口からTurso pipeline bodyのprotected SQL一致まで確認し、deny / unsupported caseはTurso call 0を確認する。

## 8. テストlevel

### L0: Fixture lint

- directoryと必須file;
- YAML / JSON Schema;
- coverage ID、case ID、profile ID;
- allow / deny別の期待file;
- fixture間の参照禁止と決定性。

### L1: Parser contract

- exactly one statement;
- accepted / rejected AST shape;
- source locationとparameter discovery;
- parser upgrade時のAST inventory差分。

### L2: Binder and typer

- stable identity;
- scope、alias、correlation;
- column usageとprovenance;
- logical descriptorとparameter inference。

### L3: Policy compiler

- policy selection;
- column non-interference;
- row-filter composition;
- limit、preset、check、redaction plan。

### L4: Emitter and independent verifier

- typed emission;
- reparse / rebind;
- semantic plan assertion;
- verifier negative controls。

### L5: Reference SQLite differential

- fixtureの`seed.sql`を独立DBへ投入;
- protected SQLを実行;
- 独立policy oracleが計算した許可row / cellと比較;
- NULL、collation、cast、limit、joinの境界を比較。

### L6: Turso profile conformance

- reference SQLiteとembedded / remote Tursoの結果比較;
- value codec、transaction、timeout、rollback、driver error normalization;
- network依存testは明示markerを付けるが、advertised capabilityのrelease gateから除外しすぎない。

### L7: Gateway and transaction

- auth canonicalizationからresponse encodingまで;
- atomic envelope、partial-result suppression、idempotency;
- operation check、commit check callback、owner loss;
- recording executorでprotected plan以外の実行がないことを確認。

### L8: Property、fuzz、metamorphic

- parser / binder / emitter / verifierへ構造化fuzz input;
- whitespace、comment、parentheses、alias renameによる意味保存;
- forbidden column追加、policy predicate削除、parameter renameによる必須拒否;
- parserとreference SQLiteのdifferential;
- timeout、depth、expression sizeを含むresource exhaustion。

#### L8の実装済み部分: 非干渉とゲートの性質ベースファジング（#125）

`crates/policysql-testkit/src/fuzz/`（生成器）と`crates/policysql-testkit/tests/noninterference/`（テスト）。`cargo test -p policysql-testkit --test noninterference`で走る。

生成したSQLを本番と同じ公開API（bind、policy compile、検証つきemit、実行）へ通し、次の3つだけを判定する。期待結果は手で書かない。

| 検査 | 内容 |
|---|---|
| SELECTの非干渉（P1の系） | 受理されたSELECTの観測（列名、行、redaction印、エラー）が、可視ビューの等しい2つのDBで等しい |
| mutationの非干渉（P3） | 受理されたUPDATE / DELETEの観測が、可視ビューの等しい2つのDBで等しい。観測は2つに分ける。(a) 影響行数、RETURNING、書き込み前に見えていた行について書き込み後に残った状態（条件付き列は書き込み前に見えていた行だけ）は全ケースで比べる。(b) 書き込み後の可視ビュー全体は、書き込みでビューが変わらないresourceだけで比べる（下の`stable_views`）。operation checkがfalseになる書き込みは、本番と同じく失敗として観測する（状態は取らない） |
| ゲート（P4） | 文が読む全resourceの`allow_aggregations`（`COUNT(*)`、GROUP BY、HAVING）または`allow_windows`（`ROW_NUMBER`）をfalseにしたpolicyで、その文が受理されない |

構成:

- ポリシーケース4つ（`base`、`logic`、`parent`、`limited`）× DB 4つ（base、`col`、`row`、`cond`）。`col`は禁止列の値、`row`は見えない行、`cond`は見えるが`visible_if`が偽の行の条件付き列だけを変える。可視ビューが等しいこと（低等価）は、コンパイラを通さない手書きSQLで毎回確かめる（`variants_are_low_equivalent`）。手書きSQLとYAMLが同じ意味であることは別に確かめる（`policy_mirror_matches_compiler`）。
- 実行エラー: 既知の除外（下）に当たらない実行時エラーは、全DBで同じでも`ExecutionError`の違反にする。#121の除外は文の形（GROUP BYの無い集約）にも限る。
- 層1: 縮約アルファベット（posts / commentsの2リソース、各4列、リテラル2個）の有界全列挙。SELECTはサイズ4以下で152,294件、UPDATE / DELETEは述語サイズ3以下で15,732件。件数は独立した数え上げの値と一致することを`layer1_counts_match_reference`で確かめる。
- 層2: 因子（`proj`、`on`、`where`、`having`）と水準（`plain`、EXISTS系4形、`count`、`forbidden`、`conditional`）の表（`layer2.rs`の`FACTORS` / `LEVELS`）から、t = 2で416セル × root 3つ = 1巡1,248件を、巡ごとに全セルをちょうど1回ずつ生成する。
- 層3: 全アルファベット（3リソース、int64、CTE、派生テーブル、クライアントパラメータ、GLOB）の乱択。夜間は大量に（SELECT 100万件 × シード）、通常の`cargo test`は先頭の標本（SELECT 600件・mutation 200件 × 5シード、`layer3_sample_*`）を回す。標本は夜間と同じ乱数列の先頭なので、`OR`、パラメータ、CTE、派生テーブル、相関EXISTS（層1・2には無い）を毎回のCIで通す。EXISTSはキー同士の`=`で確率0.45で相関させる。UPDATE / DELETEの述語のEXISTSはpolicy段で拒否されるので、mutationの標本には期待しない。同じSQLとパラメータは2回流さず、集計に`skipped as duplicates`として出す。
- 到達数の下限: どのテストも、全DBで成功した文（エラー無し、operation check失敗も無し。check失敗は失敗の有無しか比べないので数えない）の数に下限を持つ（層1は件数が決まっているので絶対値、層2は`t`ごと、層3は生成数の割合）。層3の標本は、既定より少ないシード（`PSQL_FUZZ_SEEDS`で1つだけ渡して再現するときなど）では標本が小さく割合が振れるので、割合の下限を4分の1にし、特徴の確認は外す。SELECTの層は、ゲートを外したbundleが拒否した文（main bundleは受理）の数にも下限を持つ。層3の標本は、`OR`、パラメータ、CTE、派生テーブル、相関EXISTSが実行まで届くことも確かめる。検査が何も届かないテストは失敗する。
- 層2は、各文がcellの水準をslotにその形で持つこと（水準のノードがslotにあり、割り当ての無いslotにEXISTS・`COUNT(*) >`・保護された列が無いこと）を、文の`meta`から確かめる。
- スタック: パイプラインを回すテストは、すべて256 MiBのスタックのスレッドで走らせる（`pipeline.rs`の`on_large_stack`）。出力SQLの再parse（`turso_parser`の`parse_expr`の再帰）が、深い文で既定の2 MiBを超えてデバッグビルドでスタックオーバーフローするため（#142。`PSQL_FUZZ_SEEDS=294096041695`、`732797941314`、`266424751947`の`layer3_sample_select_parent`）。これは製品側の問題で、テストは異常終了を避けるだけ。#142が直ったら、このスレッドを外せるかを確かめる。
- 検査そのものが働くことは、わざと壊したコンパイラ（SELECT / DELETEの行フィルタ欠落、禁止列の公開、条件付き列を常に見せる`visible_if`、ゲートが効かないbundle）で確かめる（`planted_*`）。
- `stable_views`: ポリシーケースがresourceごとに宣言する。そのresourceの`visible_if`が書ける列を読まず、`exists`の対象に変更できるresourceが無いとき、書き込み後の可視ビュー全体を比べる。宣言は手書きSQLから導いた値と`CaseWorld::new`が突き合わせる。

環境変数（不正な値はテストを失敗させる。黙って既定に戻さない）:

| 変数 | 既定 | 意味 |
|---|---|---|
| `PSQL_FUZZ_MAX_SIZE` | 4 | 層1のSELECTのサイズ上限（4または5） |
| `PSQL_FUZZ_MUTATION_MAX_SIZE` | 3 | 層1のmutationの述語のサイズ上限（3または4） |
| `PSQL_FUZZ_T` | 2 | 層2のt（1〜3） |
| `PSQL_FUZZ_ROUNDS` | 2 | 層2のシードごとの巡数 |
| `PSQL_FUZZ_SEED_COUNT` | 5 | シードの数。i番目のシードは`splitmix64(0x0125_0000 + i)` |
| `PSQL_FUZZ_SEEDS` | なし | シードの明示的な一覧（`,`区切り、10進か`0x`）。あれば`SEED_COUNT`より優先 |
| `PSQL_FUZZ_CASES` | 20,000 | 層3のSELECTのシードごとの件数（`#[ignore]`のテストだけが読む） |
| `PSQL_FUZZ_MUTATION_CASES` | 5,000 | 層3のmutationのシードごとの件数（同上） |

夜間（`.github/workflows/fuzz-nightly.yml`、releaseビルド）は層1をSELECT 5以下・mutation 4以下、層2をt = 3・5巡・シード20個、層3をシード4個 × SELECT 100万件・mutation 20万件で回す。手元では`cargo test -p policysql-testkit --release --test noninterference -- --ignored --nocapture layer3`で層3を走らせる。失敗は層・ケース・シード・番号とSQLで再現できる（出力の`label`）。

生成しない範囲:

- INSERT（`statement.insert.values`。P2として別に扱う）。
- JSON collection（`source.json-table.collection`、`expression.aggregate.json-group-array`、`result.json-array-schema`）。
- preset列を持つポリシー（`policy.mutation.preset`）、実行器のトランザクションのロールバック（`execution.transaction.rollback`）、operation check失敗時のロールバックそのもの（観測は失敗として扱うだけで、本番のロールバックは再現しない）。
- 負のLIMIT / OFFSET（#136）。policy limitが効くことの主張の違反で、非干渉の違反ではないため、このテストの検査では原理的に見えない。
- UPDATE / DELETEのfilterがselectのfilterより広いポリシー（#118）。P3の範囲外。常設のポリシーケースは両者を同じにし、#118の現状は`known_gap_118_wider_mutation_filter`が期待値つきで記録する。
- 書き込みで隠れていた行や値が見えるようになるポリシー（#140）: 書ける列が`visible_if`に入る、変更できるresourceが他のresourceの`exists`の対象になる。常設のポリシーケースは仕様どおりこの形を含む（`logic`のcommentsは`body`、`parent`のpostsはDELETE可、`limited`のpostsは`status`）が、書き込み後の可視ビュー全体を比べるのは`stable_views`が真のresourceだけで、ほかは(a)の観測（書き込み前に見えていたものに限る）で比べる。この形で(a)は一致し(b)が分かれることを、`known_gap_140_*`が期待値つきで記録する。
既知の除外（`oracle.rs`の`KNOWN_ISSUES`）。比較は通常どおり行い、集計で`known #N`として別に数える。直ったら表の行を消す:

- #121: 実行時の`InvalidResult`。
- #122: verifyの`registered function argument`（`CAST(COUNT(*) AS TEXT)`）。

## 9. 独立oracle

compiler自身を期待値生成器にしない。`policysql-testkit`に小さなreference policy evaluatorを実装し、fixtureのseed rowに対して閉じたpolicy predicateを直接評価する。

oracleはSQLを生成せず、SQLのTRUE / FALSE / UNKNOWNを明示的にモデル化する。SELECTの期待row、conditional outputのredaction、mutation post-state checkを計算し、DBで実行したprotected SQLの結果と比較する。

oracleが対応しないpolicy operatorは、そのoperatorをadvertiseできない。

## 10. Multi-database profile coverage

ADR 0011に従い、profileごとに独立したsurface台帳とfixture結果を持つ。共通policy fixtureを再利用する場合も、生成SQL、verifier、codec、engine resultはprofile別に保持する。

新profileは次をすべて満たすまで`advertised`にできない。

- frontendが全advertised syntaxをbindする;
- backend固有emitterと独立verifierがある;
- profile markerが異なるplanをexecutorが型またはruntime guardで拒否する;
- NULL、comparison、collation、cast、parameter、function、transactionのconformance fixtureがある;
- common policy oracleとのdifferentialが成功する;
- capability reportにuncovered leafがない。

## 11. CIとrelease gate

PRの必須jobを次の順序にする。

```text
fixture-lint
  -> unit / golden / adversarial / reference-SQLite differential
  -> executed coverage evidence
  -> coverage-check
  -> workspace lint / test
  -> profile conformance
  -> fuzz smoke
```

releaseでは長時間fuzz、remote Turso conformance、transaction failure injectionを追加する。

以下はいずれもmerge blockerとする。

- 新しいaccepted AST nodeに4分類のfixtureがない;
- coverage reportにadvertisedかつuncoveredのleafがある;
- protected SQLがindependent verifierを通らない;
- deny caseでexecutorが呼ばれる;
- differential resultがoracleと異なる;
- error snapshotにhidden情報が含まれる;
- security regression fixtureが再現しない;
- parser、engine、profile更新でinventoryまたはconformance結果が変わったまま未review。

## 12. Security regression手順

脆弱性またはbypass候補を発見した場合は、修正前に次を行う。

1. 最小の入力bundleをfixtureとして固定する;
2. `threat.*` coverage IDを付ける;
3. 現在の誤ったprotected SQLまたはexecutor呼び出しを記録する;
4. 期待値をdenyまたは安全なverified planとして定義する;
5. fixtureが失敗することを確認する;
6. 修正後に全profileの関連coverageを実行する;
7. 同じAST familyへmutation fuzz corpusを追加する。

regression fixtureは削除せず、仕様変更時も新しい期待値と理由をADRへ紐付ける。

## 13. 完了条件

初期single-table SELECT compilerのテスト基盤は次を満たしたとき完了とする。

- SQLite v1 surface台帳がreview済み;
- 全advertised leafにpositive、negative、bypass、differential coverageがある;
- 常時拒否surfaceに代表的な各statement / clause / expression family fixtureがある;
- allow fixtureは入力bundleと実行protected SQL / verified planが1対1で追跡できる;
- deny fixtureはexecutor call 0を証明する;
- 独立oracleとreference SQLiteの結果が一致する;
- second-pass verifierのnegative controlがすべて拒否される;
- coverage reportをCI artifactとして閲覧できる;
- fixture追加なしにcapabilityをadvertiseできない。
