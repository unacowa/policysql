# PolicySQL実装計画

> この文書はpolicy compilerとbackend profileの実装順を定義する。Cloudflareへの
> 常設デプロイ、concrete remote Turso transport、運用受け入れ条件は
> [`operational-deployment-implementation-plan.md`](operational-deployment-implementation-plan.md)
> を正本とする。Milestone 6 / 7は同計画のdeployment exit gateが完了するまで
> operationally completeではない。

## 1. 実装方針

実装順序は機能数ではなく、セキュリティ不変条件を独立にテストできる順序で決める。最初の成果物はTursoへ接続するgatewayではなく、入力bundleからVerified Execution Planまたはstable rejectionを生成するdatabase非依存compiler sliceとする。

すべてのmilestoneで次を守る。

- default denyを維持する;
- capabilityを実装より先にadvertiseしない;
- parser ASTをpolicy判断へ直接使用せず、stable identityを持つproject-owned bound IRへ変換する;
- client / server parameter namespaceを型で分離する;
- executorへraw SQLを渡さない;
- emitted SQLを再parseし、独立checkerで検証する;
- feature実装より先にテスト計画のfixture pairとcoverage IDを追加する。

## 2. Target module structure

ADR 0011を踏まえ、次の境界へ段階的に移行する。

```text
crates/
  policysql-core/              identities, logical values, snapshots, errors
  policysql-ir/                bound IR, protected relational plan
  policysql-catalog/           logical Catalog and registry contracts
  policysql-parser/            initial SQLite frontend and binder
  policysql-policy/            portable policy model and compiler
  policysql-sqlite/            SQLite emitter, verifier, codec, profile
  policysql-execution/         opaque verified plan and executor ports
  policysql-turso/             Turso executor and transaction adapter
  policysql-gateway/           auth and request orchestration
  policysql-testkit/           fixture runner, oracle, coverage report
```

crate名は後で分割できるが、依存方向は次に固定する。

```text
gateway ─┬─> parser ─> ir ─> core
         ├─> policy ─> ir / catalog / core
         ├─> sqlite ─> execution / ir / core
         └─> turso ──> execution / core

testkit may depend on all production crates.
production crates must not depend on testkit.
```

`policysql-turso`から`policysql-sqlite::SqlValue`への直接依存は解消し、backend-neutralなlogical / wire valueとopaque verified planだけを受け取る。

## 3. Milestone 0: Test contract first

### 実装

1. `tests/sql-surface/*.yaml`のschemaとloader;
2. fixture directoryと`case.yaml`のschema;
3. fixture lint;
4. coverage IDとfixtureの双方向検査;
5. recording executor;
6. Markdown / JSON coverage report;
7. CI job `fixture-lint`と`coverage-check`。

### 最初に移植するfixture

- `examples/basic`を最初のallow pairへ変換;
- `spec/fixtures/policy-nullable/sql-cases.json`をdirectory fixtureへ分割;
- statement smuggling、missing policy、forbidden filter column、server parameter collisionを最初のdeny / bypass fixtureとして追加。

### Exit gate

- intentionally uncoveredなadvertised leafを入れるとCIが失敗する;
- allow fixtureからprotected SQLを消すとCIが失敗する;
- deny fixtureからerrorまたはexecutor call assertionを消すとCIが失敗する;
- coverage reportからcaseとSQL surfaceの対応を追跡できる。

## 4. Milestone 1: Backend-neutral core and sealed execution

### 実装

- `ResourceId`、`ColumnId`、`PolicyId`、`SnapshotId`、`BackendProfileId`;
- validated identifierとresult name;
- logical value / type / representation descriptor;
- `ClientParameterName`と`ServerParameterName`;
- immutable `TrustedSession`。ADR 0005に従いsession値はstringのみ;
- `BoundStatement` / `BoundExpr`の最小SELECT node;
- `ProtectedPlan`;
- private constructorを持つ`VerifiedExecutionPlan<Profile>`;
- executor portをraw `String`からverified planへ変更。

### Security tests

- empty / invalid / case-colliding identity;
- clientからserver parameter typeを構築できない;
- 別profileのplanをexecutorへ渡せないcompile-fail test;
- verifier以外からverified planを生成できないcompile-fail test;
- snapshot/profile fingerprint mismatch。

### Exit gate

- production executor APIに任意SQL文字列を受け取るpublic pathがない;
- parser / driver固有型がcore / IRへ現れない;
- current scaffoldのsession modelとADR 0005の不一致が解消される。

## 5. Milestone 2: SQLite parser and single-table binder

### Accepted surface

```sql
SELECT <explicit base columns>
FROM <one base resource> [AS alias]
[WHERE <simple boolean expression>]
[LIMIT <non-negative literal or named parameter>]
```

### 実装

- real SQLite-capable parser integration;
- exactly-one-statement enforcement;
- parser ASTから最小bound IRへの変換;
- Catalog resolution;
- source scopeとalias;
- projection / filter usage;
- logical parameter inference;
- expression complexity / depth / parameter count limit;
- unsupported nodeのstable rejection分類。

### Security tests

- SQL surface台帳のstatement、source、expression、binding leaf;
- semicolon / comment smuggling;
- quoted identifier、unknown / ambiguous、implicit rowid;
- star、function、subquery、join、CTEなど未advertised nodeのdeny;
- parser fuzz corpusとreference SQLite parse differential。

### Exit gate

- accepted SQLの全columnがstable ColumnIdへ解決される;
- provenanceを証明できないSQLはすべて拒否される;
- parser dependencyのsecurity-relevant AST inventoryが台帳化される。

## 6. Milestone 3: Policy loading and SELECT compiler

### 実装

- policy JSON Schema validation;
- Catalog-aware semantic validation;
- immutable policy bundle activation;
- resource × role × select policy selection;
- regular / forbidden / conditional output column permission;
- closed boolean predicateのtyped compilation;
- caller predicateとpolicy predicateのAND composition;
- stricter effective limit;
- authorization / Explain trace。

### Security tests

- missing policy = deny;
- forbidden columnの全usage context;
- caller predicateがpolicyをOR / NOT / constantで弱められない;
- SQL TRUE / FALSE / UNKNOWN;
- session descriptor compatibilityとcoercion禁止;
- conditional outputのdirect projection以外を拒否;
- policy bundle全体のfail-closed activation。

### Exit gate

- 全allow planのbase resourceにpolicy predicateまたは明示的unrestricted policy markerがある;
- policy compiler単体testにDB credentialが不要;
- policy oracleとcompiler planの意味がfixture全件で一致する。

## 7. Milestone 4: SQLite emission and independent verification

### 実装

- string concatenationではないtyped emitter;
- deterministic compiler-owned alias;
- server parameter allocation;
- protected SQLとparameter map;
- emitted SQLの再parse / rebind;
- 独立invariant checker;
- verified plan sealing。

### Independent checker requirements

- exactly one statement;
- expected operation / resource / column access set;
- expected policy predicate coverage;
- client / server parameter ownership;
- effective limit;
- forbidden node absence;
- result descriptorとのprojection対応;
- Backend Profile一致。

### Security tests

- policy削除、column追加、statement追加、parameter置換のnegative control;
- emitter/parser differential;
- 同一入力とsnapshotのdeterministic output;
- protected SQL goldenとsemantic plan assertion。

### Exit gate

- compilerが生成したすべてのallow SQLがsecond-pass verifierを通る;
- 意図的に壊した出力をcheckerが全件拒否する;
- verified planなしにrecording executorへ到達できない。

## 8. Milestone 5: Explain, oracle, reference execution

### 実装

- client parameter descriptor;
- final result descriptor;
- applied policy / accessed resource trace;
- protected SQL redaction setting;
- in-memory reference policy oracle;
- reference SQLite fixture runner;
- result value validatorとredaction metadata encoder。

### Security tests

- ExplainとExecute compile pathが同じcompilerを使用する;
- Explainがruntime parameter値から型を推論しない;
- oracle / protected SQL differential;
- DB NULLとpolicy redaction NULLの区別;
- duplicate result nameとruntime storage-class mismatch;
- error / Explain redaction。

### Exit gate

- 初期SELECTの全allow fixtureがreference SQLiteでexpected resultを返す;
- 全deny fixtureでexecutor callが0;
- query generatorに必要なdescriptorが安定している。

## 9. Milestone 6: Gateway without Turso dependency

### 実装

- Atomic Execute / Explain envelope;
- JWT verifier portとtrusted-session canonicalization;
- endpoint access separation;
- snapshot pinning;
- mode inference;
- cumulative request limit;
- safe error mapping;
- recording / in-memory executorによるend-to-end test。

### Exit gate

- HTTPからVerified Execution Planまでのsecurity fixtureが通る;
- build credentialでexecuteできない;
- 全item compile完了前にexecutorを呼ばない;
- failure時にpartial resultを返さない。

## 10. Milestone 7: Turso executor profile

### 実装

- `VerifiedExecutionPlan<SqliteTursoProfile>` executor;
- embedded / remote transport abstraction;
- read / write transaction;
- row / byte / timeout limit;
- result codecとlogical descriptor validation;
- retryable conflict / raw driver error normalization;
- idempotency storage port。

### Exit gate

- reference SQLiteとTurso conformance fixtureが一致する;
- raw SQL execution APIがpublicまたはapplication layerにない;
- network / timeout / rollback failureでsafe errorを返す;
- initial SELECT releaseに必要なcoverage reportが100%。

## 11. Milestone 8: Read surface expansion

次の順に1 featureずつ追加する。

1. ORDER BY;
2. INNER JOIN;
3. LEFT JOIN;
4. derived table;
5. non-recursive CTE;
6. subquery / correlation;
7. aggregation / GROUP / HAVING;
8. window / registered function。

各featureの作業順は固定する。

```text
surface ID追加（disabled）
  -> 4分類fixture追加
  -> binder / provenance
  -> resource/column policy semantics and aggregate/window gates
  -> emitter
  -> independent verifier
  -> differential test
  -> Cloudflare / Turso egress allow and deny-0-call tests
  -> capabilityをadvertisedへ変更
```

JOINは全resourceのselect policyと全参照column permissionを要求する。GROUP / HAVING / windowはdeployment capabilityに加えてdefault-falseの`allow_aggregations` / `allow_windows`を要求し、deny時のDB executor / Turso egress call 0をfixtureで証明する。

JOINでは全base resourceのselect policyと、ONを含む全参照columnのregular permissionを要求する。LEFT JOINではnullable側policyをONへ置くfixtureと、誤ってWHEREへ置いたnegative controlを必須とする。subquery / CTEではbase resourceまでprovenanceを追跡できない形を拒否する。

GROUP / HAVINGでは、projection許可columnとgroup/having許可columnを分離する。windowではfunction、PARTITION BY column、window ORDER BY columnを個別にallowlist化する。

## 12. Milestone 9: Mutations and transaction integrity

実装順は`INSERT VALUES → DELETE → UPDATE → RETURNING → preset → operation check → commit check`とする。

### Security requirements

- caller write columnとpreset columnがdisjoint;
- pre-state filterをwrite statementへ組み込む;
- post-stateを同一transaction内で検証;
- checkはTRUEのみ成功、FALSE / UNKNOWNはrollback;
- zero-row behaviorと`expect.affectedRows`;
- RETURNINGを独立認可;
- callbackはSELECTのみ、immutable role、same transaction;
- owner loss、timeout、malformed responseはrollback;
- partial result suppression;
- write retryをauth context、endpoint、payload hashへbind。

### Exit gate

- 各mutationのpositive / negative / bypass / differential fixture;
- failしたoperation / commit check後に永続rowが0;
- callbackからmutation、role選択、commit / rollbackが不可能;
- transaction failure injection suiteが成功。

## 13. Milestone 10: PostgreSQL profile readiness

初期roadmapには含めない。ADR 0011のfollow-upとして、別ADRで次を決定してから着手する。

- public PostgreSQL subset;
- parserとAST inventory;
- identifier、parameter、type、collation、cast semantics;
- Catalog introspection;
- emitterと独立verifier;
- executorとtransaction behavior;
- PostgreSQL-specific surface台帳;
- common policy oracleとのconformance。

SQLite profileのfixtureをそのまま成功扱いにせず、共通fixture IDに対するPostgreSQL固有expected plan / SQL / resultを持つ。

## 14. PR実装単位

1 PRで追加できるaccepted SQL surfaceは原則1つのAST familyに限定する。PR descriptionには次を必須とする。

- 新しくadvertiseするcoverage ID;
- 対応fixture pair;
- 新AST nodeのpolicy behavior;
- 検討したbypass;
- emitted SQLを再parseしている根拠;
- resource limitへの影響;
- safe errorへの影響;
- coverage report差分。

security fixは回帰fixtureを最初のcommitに置き、fix commitと区別できるようにする。

## 15. CI導入順序

### 常時必須

- format / Clippy / unit / doc test;
- schema validation;
- fixture lint;
- SQL surface coverage;
- golden / semantic assertion;
- adversarial negative control;
- reference SQLite differential。

### Nightly

- 長時間fuzz;
- parser differential corpus;
- remote Turso conformance;
- transaction failure injection;
- resource exhaustion boundary。

### Release

- 全nightly suite;
- capability / coverage report署名またはartifact保存;
- dependency / parser / engine version inventory;
- known regression全件;
- generated client compatibility。

## 16. 実装完了の判定

「実装済み」はコードが存在することではなく、次をすべて満たすことと定義する。

1. capabilityが台帳に登録されている;
2. 必要な4分類fixtureがある;
3. binderが完全なprovenanceを返す;
4. policy behaviorが全usage contextで定義されている;
5. typed emitterとindependent verifierがある;
6. reference engine differentialが通る;
7. safe errorとresource limitがある;
8. CI coverage reportにuncovered advertised leafがない;
9. documentationとCapabilitiesが一致する。

この条件を満たさないSQL形状は、parserが理解できてもpublic endpointでは拒否する。
