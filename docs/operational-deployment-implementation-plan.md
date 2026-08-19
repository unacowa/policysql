# PolicySQL Cloudflare/Turso運用デプロイ実装計画

## 1. 目的

この計画は、実装済みのSQLite/Turso v1 policy compilerを、実Cloudflare
Workersと実Turso Databaseへ安全に接続し、認証されたクライアントが公開URLへ
`curl`してExplainとSQL実行を行える状態まで完成させる。

コンパイラライブラリ、transport trait、recording executorが存在するだけでは
本計画の完了としない。常設環境へのデプロイ、実エンジンconformance、運用制限、
監視、失敗時の復旧を含めて完了を判定する。

## 2. 最終成果物とDefinition of Done

運用デプロイは、次をすべて満たした場合だけ`complete`とする。

1. CloudflareアカウントにversionedなPolicySQL Workerが常設されている;
2. Workerが実Turso Databaseへsealed planだけを使って接続する;
3. JWT署名、issuer、audience、時刻、role、accessを検証してからSQLをparseする;
4. version-pinnedなCatalog、Policy、Capabilities snapshotが起動時にfail-closedでactivateされる;
5. `healthz`、Capabilities、Catalog、Explain、atomic Executeが公開契約どおり応答する;
6. SELECTとadvertised mutationが実Turso conformance suiteを通る;
7. row、result byte、SQL size、parameter、statement、join、depth、timeout、Turso usage budgetが強制される;
8. Tursoの`rows_read`、`rows_written`、`query_duration_ms`を取得し、request IDと関連付けて記録する;
9. interactive transactionとcommit checkをadvertiseする場合、Durable Object owner-loss suiteを通る;
10. safe error、rate limit、audit、metrics、rollback手順が動作する;
11. clean environmentから再現可能なdeploy commandとrollback commandがある;
12. 下記のrelease curl suiteが実URLに対して成功し、deny/bypass caseではDB callが0である。

常設環境のURL、Worker version、Catalog/Policy/Capabilities hash、Turso database identity、
テスト時刻をsanitized release artifactへ保存する。tokenやdatabase credentialは保存しない。

## 3. 現在地と未実装境界

| 領域 | 現在地 | 運用デプロイに必要な残作業 |
| --- | --- | --- |
| Parser / binder / policy compiler | 実装済み | Wasm ABIと実リクエストconformance |
| SQLite emitter / independent verifier | 実装済み | deployment snapshotとのversion binding |
| Gateway orchestration | Rust libraryとして実装済み | HTTP listener、request codec、response codec |
| JWT | traitと契約のみ | JWKS取得、署名検証、cache、claim canonicalization |
| Turso | typed traitと結果検証のみ | concrete SQL over HTTP transport、timeout、metrics |
| Transaction | state machineとspikeあり | Durable Object常設実装、owner loss、idempotency persistence |
| Cloudflare | disposable spikeとbenchmarkのみ | production Worker package、secrets、deploy、rollback |
| Operations | 文書契約中心 | logs、metrics、alerts、usage budget、runbook |

既存の`policysql-gateway` Milestone 6と`policysql-turso` Milestone 7は、
運用adapterのexit gateが完了するまで`partial / reopened`として扱う。

## 4. 固定するアーキテクチャ境界

### 4.1 Rustが所有する領域

- request envelopeの意味検証;
- trusted sessionとrole/accessのcanonicalization;
- Catalog / Policyのschema・semantic validationとsnapshot activation;
- SQL parse、binding、policy compile、typed emission、reparse、independent verification;
- sealed execution planとexpected result descriptor;
- client/server parameter namespace;
- Turso response value、column、row、byte、cardinality、redaction validation;
- safe domain error code;
- transaction / commit-check state transitionの規則。

### 4.2 TypeScript Workerが所有する領域

- Cloudflare Fetch handlerとrouting;
- request bodyのtransport-level size制限;
- WebCryptoによるJWT/JWKS adapter;
- secrets / bindingsの取得;
- Turso SQL over HTTPまたは公式serverless client adapter;
- AbortSignal、deadline、network retry分類;
- Durable Object routingとstorage;
- structured log、metrics、HTTP response encoding;
- deployment metadataとhealth reporting。

TypeScriptはpolicy判断、SQL文字列の変更、列permission判定を行わない。
外部requestから`protectedSql`、server parameter、profile marker、snapshot hashを
受け取るfieldを設けない。

### 4.3 実行境界

```text
Untrusted HTTP request
  -> transport/schema limits
  -> JWT signature + claim validation
  -> Rust trusted-session canonicalization
  -> Rust compile + seal
  -> cost admission
  -> Turso adapter executes protected SQL only
  -> Rust validates raw result + usage metadata
  -> public response encoder
```

public handlerからTurso clientへ直接client SQLを渡すpathを禁止する。テストでは
Turso adapterをspy化し、deny request、Explain、認証失敗でexecute callが0であることを検証する。

## 5. Target module structure

```text
crates/
  policysql-cloudflare/        Rust/Wasm deployment ABI and wire DTOs
  policysql-gateway/           backend-neutral request orchestration
  policysql-turso/             sealed-plan Turso validation and ports

deploy/cloudflare/
  src/index.ts                 fetch entrypoint and route dispatch
  src/auth.ts                  JWKS/JWT transport adapter
  src/config.ts                immutable snapshot/config loader
  src/turso.ts                 sealed-plan-only remote transport
  src/cost.ts                  EXPLAIN and historical usage adapter
  src/transaction-owner.ts     Durable Object transaction owner
  src/errors.ts                safe HTTP error mapping
  src/observability.ts         logs, metrics, request IDs
  wrangler.jsonc               bindings, limits, environments
  scripts/deploy.mjs           reproducible deploy and health gate
  scripts/rollback.mjs         version-pinned rollback

tests/deployment/
  curl-smoke.mjs               real URL acceptance suite
  turso-conformance.mjs        reference SQLite / remote Turso comparison
  failure-injection.mjs        timeout, malformed result, owner loss
  usage-budget.mjs             rows read/write admission and reconciliation
```

Wasm ABIはversioned DTOだけを公開し、Rust domain typeやparser ASTを直接公開しない。
ABI decodeではunknown field、duplicate key、non-canonical identifier、oversized valueを拒否する。

## 6. Milestone D0: Ledgerと受け入れ契約の是正

### 実装

- 既存Milestone 6 / 7を`partial / reopened`へ変更する;
- compiler completionとoperational completionを別ledgerにする;
- OpenAPIとJSON Schemaからrelease curl fixtureを生成する;
- Cloudflare/Turso環境のCapabilities IDを定義する;
- staging / productionのsecret、URL、database identityを分離する。

### Exit gate

- `complete`に変更するには実デプロイ証跡が必要になる;
- curl fixtureが存在しないendpointはadvertiseできない;
- staging credentialでproductionへ接続できない。

## 7. Milestone D1: Cloudflare Worker packageとRust/Wasm ABI

### 実装

- `policysql-cloudflare`を`cdylib`として追加する;
- Catalog / Policy / Capabilities activation API;
- Explain / Execute compile API;
- sealed-plan wire DTOとraw Turso result validation API;
- Worker起動時にWasmを一度だけ同期初期化する;
- `/healthz`はDB接続を伴わないlivenessと、明示的なreadinessを分離する;
- Worker version、ABI version、compiler versionをhealth metadataへ含める。

### Security tests

- malformed JSON、duplicate key、oversized snapshot、unknown DTO version;
- forged protected SQL、profile mismatch、snapshot mismatch;
- Wasm initialization failureとpartial activation;
- handlerからcompilerを迂回したTurso callのnegative control。

### Exit gate

- `wrangler deploy --dry-run`が成功する;
- gzip bundleがFree上限3 MB未満かつ運用余白を含む2.5 MB以下である;
- startupがCloudflare上限1秒未満である;
- Worker package内にraw-SQL public transportがない。

## 8. Milestone D2: Immutable configurationとJWT authentication

### 実装

- Catalog / Policyをversioned deployment assetまたは署名済みconfigとして読み込む;
- hashを計算し、全requestを同一immutable snapshotへpinする;
- JWKS取得、許可algorithm固定、`kid`選択、issuer、audience、`exp`、`nbf`検証;
- JWKS cache TTL、stale-key behavior、rotation、fetch timeout;
- duplicate Authorization / role header rejection;
- JWT accessからExecute / Explain / Catalog permissionを分離する;
- session claimをRustへ渡し、reserved keyとtype compatibilityを再検証する。

### Security tests

- `alg=none`、algorithm confusion、unknown `kid`、duplicate header;
- expired / future token、issuer/audience mismatch;
- role escalation、reserved session key、ambiguous claim mapping;
- JWKS timeout、malformed response、rotation race;
- build/catalog credentialによるExecute拒否。

### Exit gate

- 実Workerの`/healthz`と認証付き`/v1/capabilities`をcurlできる;
- 認証失敗時にcompiler / Turso callが0;
- key rotation中も未知keyをfail-openしない。

## 9. Milestone D3: Explain endpointの常設デプロイ

### 実装

- `POST /v1/transactions:explain`;
- `GET /v1/catalog`;
- `GET /v1/capabilities`;
- request schema、content type、body size、statement count、SQL size、parameter limits;
- ETagとsnapshot precondition;
- safe error mappingとrequest ID。

### Exit gate

- 実URLへ認証付きcurlでparameter/result descriptorを取得できる;
- ExplainがTursoへ接続しない;
- allow / deny / bypass fixture pairを同じHTTP pathで実行できる;
- protected SQLの公開設定がCapabilitiesと一致する。

## 10. Milestone D4: Remote Turso SELECT execution

### 実装

- sealed planだけを受け取るconcrete Turso transport;
- client / server parameterの別namespaceからdriver bindingへ変換する;
- deadlineとAbortSignalをrequest全体へ伝播する;
- Turso responseからcolumns、rows、`rows_read`、`rows_written`、
  `query_duration_ms`、affected rowsを取得する;
- raw resultをRust validatorへ戻し、検証完了前に公開しない;
- result row / byte上限をprotected SQLとdecoderの両方で防御する;
- retry可能network errorとretry不可database errorを正規化する。

### Conformance tests

- 全advertised SELECT fixtureをreference SQLiteと実Tursoで比較する;
- NULL、logical type、alias、JOIN、CTE、EXISTS、aggregate、window、LIMIT;
- malformed columns、storage-class mismatch、too many rows、too many bytes;
- network timeout、truncated JSON、Turso error redaction;
- deny fixtureでremote requestが0。

### Exit gate

- `POST /v1/transactions:execute`を実URLへcurlして実DB rowを取得できる;
- responseにsanitized usage metadataまたは内部metricが記録される;
- remote Turso conformanceがrelease gateで成功する;
- client SQLがTurso transportへ直接到達するtestが存在しない。

## 11. Milestone D5: 課金量推定とresource admission

### 実装

- sealed protected SQLに対するtrusted `EXPLAIN QUERY PLAN` adapter;
- schema/index snapshotとtable cardinalityを保持するCost Catalog;
- `SCAN`、`SEARCH`、nested loop、correlated subquery、TEMP B-TREE、aggregateを分類する;
- `rows_read` / `rows_written`のlower / expected / upper boundとconfidenceを生成する;
- upper bound不明、nested full scan、予算超過をdefault denyする;
- tenant、role、request、transactionごとのusage budget;
- 実行後Turso metricsとのreconciliationとSQL fingerprint別補正;
- estimation自体のTurso usageもaccountingする。

### 初期admission rule

- self JOIN、FULL / RIGHT JOIN、CROSS JOINは引き続き拒否;
- JOIN内側のunbounded `SCAN`は拒否;
- JOIN + aggregate / windowは明示budgetなしでは拒否;
- correlated subqueryのinner `SCAN`は拒否;
- estimated upper rows read / writtenがdeployment limitを超えたら拒否;
- planner outputが未知なら拒否。

### Exit gate

- `explain`結果に認可されたcost estimateを含められる;
- 既知のJOIN爆発fixtureがTurso本体のquery実行前に拒否される;
- actual / expected ratioを記録し、閾値超過をalertできる;
- planner version変更でparser conformance testが失敗する。

## 12. Milestone D6: Atomic mutation execution

### 実装

- atomic envelopeのmode inference;
- write transaction、INSERT / UPDATE / DELETE / RETURNING;
- preset、pre-filter、post-state check、affected-row expectation;
- idempotency keyをissuer / subject / role / endpoint / payload hashへbindする;
- terminal response persistenceとin-progress競合;
- rollback時のpartial result suppression;
- Turso rows written budgetをwrite開始前にadmissionする。

### Exit gate

- mutation fixtureが実Tursoでreference resultと一致する;
- check failure、timeout、network loss、result validation failureで永続変更が0;
- 同一idempotency key + 同一payloadは同じterminal responseを返す;
- 同一key + 異なるpayloadを拒否する;
- aborted writeのTurso usageを記録する。

## 13. Milestone D7: Interactive transactionとcommit checks

### 実装

- Durable Objectをtransaction ownerとして使用する;
- transaction IDをDO IDへ安全にmappingする;
- auth/session/snapshot/payload fingerprintをownerへ固定する;
- monotonic sequence、exact retry、commit / rollback terminal retention;
- external hook timeout、HMAC、callback capability;
- callback SELECTを同一transactionへserial routingする;
- owner eviction、deployment、baton expiry、connection lossをterminal rollbackとして扱う。

### Exit gate

- start → statement → callback → commitを実URLでcurlできる;
- forced `DurableObjectState.abort()`でuncommitted rowが0;
- owner replacementがtransactionを復元したふりをしない;
- callbackからmutation、role変更、別transaction参照ができない;
- deployment中のactive transaction behaviorをrunbookに記録する。

## 14. Milestone D8: Observability、運用、hardening

### 実装

- structured audit event、request / transaction correlation ID;
- endpoint、outcome、safe error、CPU、wall、Turso duration、rows read/write metrics;
- credential、SQL parameter、hidden schema、policy predicate、raw DB errorのredaction;
- per-IP / issuer / subject / tenant rate limiting;
- request deadline、concurrency、memory、result serialization limit;
- alert: auth anomaly、deny spike、CPU、Turso usage、cost misestimate、transaction leak;
- dependency inventory、SBOM、secret rotation、incident response;
- staged rollout、health gate、rollback、database migration separation。

### Cloudflare plan gate

- Free deploymentをadvertiseする場合、cold startを含むCPU実測が10 ms制限内である;
- 制限を満たさない場合はPaid planをrequired capabilityとして記録する;
- bundle、startup、memory、request/day、DO usageをrelease artifactへ記録する。

### Exit gate

- secretを含まないlog snapshot testが通る;
- rate limitとusage budgetが実Workerで作動する;
- previous Worker versionへのrollback drillが成功する;
- expired/revoked token、Turso outage、JWKS outage、DO resetのrunbook drillが成功する。

## 15. Milestone D9: Release deploymentとcurl acceptance

### 必須curl suite

実URLに対して最低限次を自動実行する。

```text
GET  /healthz                                  -> live / ready
GET  /v1/capabilities                          -> authenticated capability snapshot
GET  /v1/catalog                               -> role-visible Catalog
POST /v1/transactions:explain                  -> no Turso execution
POST /v1/transactions:execute (SELECT)         -> expected protected rows
POST /v1/transactions:execute (mutation)       -> expected commit
POST /v1/transactions:execute (deny fixture)   -> safe rejection, DB call 0
POST /v1/transactions:execute (cost bomb)      -> pre-execution rejection
POST /v1/transactions                          -> begin interactive transaction
POST /v1/transactions/{id}/statements          -> read-your-writes
POST /v1/transactions/{id}/rollback            -> no persisted row
```

各requestについてstatus、safe response schema、request ID、snapshot hash、Worker version、
Turso rows read/write、database post-stateをassertする。

### Release artifact

- sanitized deployment manifest;
- bundle sizeとstartup time;
- Cloudflare CPU / wall trace summary;
- Turso conformance report;
- SQL surface coverage report;
- curl suite report;
- failure-injection report;
- known limitationsとrequired Cloudflare/Turso plan;
- rollback対象version。

### Final exit gate

- 上記artifactが同一Worker versionを指す;
- 全advertised endpointとSQL leafが実環境で検証済み;
- temporary benchmarkではなく常設deploymentが存在する;
- READMEに実URLの設定方法とcurl quickstartがある;
- operatorがcredentialを再発行し、deploy、health確認、rollbackを再現できる。

## 16. テスト実行順序

```text
format / lint / unit
  -> schema / fixture / surface coverage
  -> compiler golden / verifier negative controls
  -> reference SQLite differential
  -> Wasm ABI conformance
  -> Worker local integration
  -> remote Turso conformance
  -> Cloudflare staging curl suite
  -> failure injection / cost bomb / resource boundaries
  -> deployment health gate
  -> production promotion or explicit staging completion
```

新しいHTTP field、transport behavior、Turso driver version、Cloudflare compatibility date、
planner output、SQL surfaceを変更するPRは、対応するnegative / bypass / differential / remote
fixtureなしにmergeできない。

## 17. 実装順の原則

- D0から順に進め、exit gate未達のMilestoneを`complete`にしない;
- Explain-only deploymentを最初の常設成果物とし、DB writeより先にauthとsnapshotを検証する;
- SELECT remote conformance完了前にmutationをadvertiseしない;
- cost admissionと実timeout完了前にJOIN / aggregate / windowを運用Capabilitiesへ載せない;
- interactive transactionをadvertiseしないdeploymentはendpointを404ではなくCapabilities上で明示し、安全なunsupported errorを返す;
- 継続不能な外部blockerがない限り、実装、テスト、staging deploy、curl acceptanceまで連続して進める。
