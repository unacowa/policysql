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
