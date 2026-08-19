---
title: Commit check
description: Transactionのcommit直前に外部logicで複数resourceの整合性を検証する仕様です。
---

# Commit check

Commit checkは、transaction内の全statementが終了した後、commit直前に外部serviceへ整合性検証を委譲します。外部serviceはPolicySQLを通して同じtransactionへSELECTを実行でき、変更したrowだけでなく、検証に必要な別resourceも読み取れます。

Commit checkは[データ正常性](../data-validity/overview)のtransaction層を担当します。単一値の型・format・constraintと、各mutationのoperation checkが成功した後に実行されます。

PolicySQLにpre-execution Validation hookはありません。外部validationは単一mutationを含め、すべてcommit checkとして実行します。

## Policy format

Commit checkはroot `policy.yaml`へ定義します。

```yaml
version: 1

includes:
  - resources/orders.yaml
  - resources/order_items.yaml
  - resources/products.yaml

commit_checks:
  order_consistency:
    triggered_by: [orders, order_items]
    role: admin
    hook:
      url_env: ORDER_VALIDATOR_URL
      timeout_ms: 1500
      hmac_secret_env: ORDER_VALIDATOR_SECRET
```

| Field | Required | Description |
| --- | --- | --- |
| `triggered_by` | yes | transactionで変更された場合にcheckを起動するresource |
| `role` | no | callback SELECTへ適用するrole。省略時はrequest実行者のrole |
| `hook.url_env` | yes | validator URLを保持するenvironment variable名 |
| `hook.timeout_ms` | yes | hook開始からdecision受信までの期限 |
| `hook.hmac_secret_env` | yes | outbound hook requestを署名するsecretのenvironment variable名 |

transactionが`triggered_by`のいずれかを変更すると、PolicySQLは対応するcommit checkを必ず実行します。clientはcheckを省略、追加、変更できません。

## Role

`role`を省略した場合、transactionを実行したroleをcallback SELECTへ引き継ぎます。trusted sessionもtransaction開始時の値を引き継ぎます。

```yaml
commit_checks:
  order_consistency:
    triggered_by: [orders, order_items]
    hook:
      url_env: ORDER_VALIDATOR_URL
      timeout_ms: 1500
      hmac_secret_env: ORDER_VALIDATOR_SECRET
```

`role`を明示した場合は、そのroleをcallback SELECTへ適用します。実行者JWTの`policysql.roles`に含まれている必要はありません。これはpolicyが付与するsystem privilegeであり、整合性検証のために`admin`などの特権roleを使用できます。

```yaml
role: admin
```

特権roleはclient request、callback request、hook responseから指定または変更できません。policyに固定されたroleだけをPolicySQLが選択し、callbackではSELECTだけを許可します。INSERT、UPDATE、DELETE、commit、rollbackは許可しません。

## Execution order

```text
transaction開始
  -> statementを順番に実行
  -> mutationごとのoperation check
  -> triggered commit checksを確定
  -> hookを呼び出す
  -> callback SELECTとdecision
  -> allowならcommit
  -> deny、timeout、protocol errorならrollback
```

mutationが実際に1 row以上変更したresourceだけが`triggered_by`と照合されます。0 row mutationはcheckをtriggerしません。複数checkが対象になった場合はcheck identifierの昇順で一つずつ実行し、それぞれに別のvalidation sessionとcapabilityを発行します。一つでも失敗した時点で残りを開始せずrollbackします。

`POST /v1/transactions:execute`では、単一mutationを含めて全statementの終了後に実行します。対話型transactionではstatementごとには呼び出さず、clientがcommitを要求した時点で実行します。

validation中、transactionは`validating`状態になります。この間はvalidatorのSELECTと最終decisionだけを受け付け、clientからのstatement追加、commit、rollbackを拒否します。

## Hook request

PolicySQLはvalidatorへJSONを`POST`します。

```http
POST /validate/order HTTP/1.1
Content-Type: application/json
PolicySQL-Hook-Version: 1
PolicySQL-Hook-Timestamp: 1785715200
PolicySQL-Hook-Signature: v1=...
```

```json
{
  "version": "1",
  "validationId": "cval_01",
  "check": "order_consistency",
  "requestId": "req_01",
  "policyVersion": "policy_42",
  "schemaVersion": "schema_17",
  "role": "admin",
  "session": {
    "subject_id": "author_01",
    "tenant_id": "tenant_01"
  },
  "statements": [
    {
      "index": 0,
      "type": "update",
      "resource": "orders"
    },
    {
      "index": 1,
      "type": "insert",
      "resource": "order_items"
    }
  ],
  "query": {
    "url": "https://gateway.example.com/v1/commit-checks/cval_01/query",
    "token": "<opaque-capability>",
    "expiresAt": "2026-08-03T12:00:04Z"
  }
}
```

JWT、利用者のBearer token、database credential、Turso connection情報、protected SQLはhookへ送信しません。

outbound requestのsignatureは次の値です。

```text
v1=hex(HMAC-SHA256(secret, timestamp + "." + raw_request_body))
```

validatorはtimestampとsignatureを検証します。redirect、平文HTTP、認証なしhookは許可されません。

## Transaction query

validatorはhook requestに含まれるquery URLへSELECTを送信します。

```http
POST /v1/commit-checks/cval_01/query HTTP/1.1
Authorization: Bearer <opaque-capability>
Content-Type: application/json
```

```json
{
  "sequence": 1,
  "sql": "SELECT id, status, price FROM products WHERE id IN (:product_id_1, :product_id_2)",
  "params": {
    "product_id_1": "product_01",
    "product_id_2": "product_02"
  }
}
```

queryはTursoへ直接渡すraw SQLではありません。PolicySQLが一つのSELECTとしてparseし、catalog bind、role policy、column permission、row filter、function allowlist、resource limit、protected SQLの再検証を適用します。その後、transaction ownerが保持する同じTurso transactionで実行します。

validatorはroleがSELECTできるすべてのresourceを参照できます。resourceが現在のtransactionで変更されたかどうかは問いません。

```json
{
  "sequence": 1,
  "columns": ["id", "status", "price"],
  "rows": [
    {
      "id": "product_01",
      "status": "active",
      "price": 1000
    }
  ],
  "rowCount": 1,
  "meta": {
    "requestId": "req_01.cq_01",
    "policyVersion": "policy_42",
    "schemaVersion": "schema_17",
    "role": "admin",
    "operation": "select",
    "result": {
      "columns": [
        { "name": "id", "type": "string", "representation": "string", "nullable": false },
        { "name": "status", "type": "string", "representation": "string", "nullable": false },
        { "name": "price", "type": "integer", "representation": "number", "nullable": false }
      ],
      "redactions": []
    }
  }
}
```

callback queryは直列に処理します。直前に完了した`sequence`と同一payloadの再送は保存済みresponseを返します。異なるpayloadでのsequence再利用、欠落、逆転、異なるqueryの並行送信はprotocol errorとしてtransactionをrollbackします。

## Decision

必要なSELECTが完了したら、validatorは元のhook requestへdecisionを返します。

```json
{
  "version": "1",
  "allowed": true
}
```

拒否する場合は`allowed: false`を返します。

```json
{
  "version": "1",
  "allowed": false,
  "error": {
    "code": "ORDER_TOTAL_MISMATCH"
  }
}
```

hookはparameter、preset、session、SQL、database rowを変更できません。decisionはallowまたはdenyだけです。

validatorの`error.code`は監査log用のapplication codeです。public clientへはそのまま転送せず、`POLICYSQL_COMMIT_CHECK_REJECTED`へ正規化します。

## Opaque capability

callback認証にはJWTを使用しません。PolicySQLはvalidation sessionごとに256-bitのrandom tokenを生成し、server側にはhashだけを保持します。

- 一つのvalidation sessionだけで有効
- callback SELECTだけに使用可能
- transaction期限より短い
- URL query parameterやlogへ出力しない
- validation終了時に即時失効
- 別transaction、別check、別roleへ転用できない

role、trusted session、policy version、schema version、transaction handleはserver側validation sessionに保持します。tokenからsecurity contextを復元しません。

## Failure handling

次の場合はfail closedでtransaction全体をrollbackします。

- hook timeoutまたは接続失敗
- signature、TLS、opaque tokenの検証失敗
- `2xx`以外のHTTP response
- malformed JSONまたは未知protocol version
- callback queryのSQL、permission、limit error
- callbackの順序違反
- validatorがdecisionを返す前の切断
- transaction ownerの喪失

外部validatorは副作用を持たせないでください。Turso DatabaseのMVCC conflictによってtransaction全体がretryされる場合、同じvalidationが複数回実行される可能性があります。課金、通知、job登録などはcommit後のoutboxで処理します。

## Transaction owner

PolicySQL coreは、開いたTurso transactionとvalidation sessionを一つのtransaction ownerへ紐付けます。callback requestを同じownerへrouteできることがdeployment adapterの要件です。coreのpolicy、compiler、protocolは特定のedge platformへ依存しません。

通常のserver deploymentでは、process内transaction registry、sticky routing、または専用coordinatorを使用できます。

Cloudflare Workersを第一サポートとするadapterでは、transactionごとにDurable Objectを割り当てます。public Workerとcallback endpointは同じobject IDへrequestを転送し、Durable ObjectがTurso transaction、opaque token、sequence、validation phaseを所有します。

Durable Objectが停止または再作成され、開いていたtransaction handleを失った場合は再開せずrollback扱いにします。validation sessionをstorageから復元して別connectionへ付け替えることはしません。

## MVCC consistency

Commit checkは、transaction snapshotとtransaction自身の未commit変更を検証します。ただし、validatorが読んだrowを別transactionが変更する場合の競合保証はTurso DatabaseのMVCC semanticsに従います。

複数rowやpredicate範囲にまたがるinvariantでは、関係するwriterが同じguard rowを変更する、またはdatabase constraintで保証する必要があります。commit checkだけでserializable isolationや外部serviceとのatomicityを提供するものではありません。
