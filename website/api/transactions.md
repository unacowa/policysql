---
title: 対話型Transaction API
description: 途中結果から次のSQLを決めるための短時間transaction lifecycleです。
---

# 対話型Transaction API

通常の単一・複数statementは[Atomic Execute API](./execute)を使用します。対話型transactionは、直前のresultをapplicationで確認しなければ次のstatementを構築できない場合だけ使用します。

開始、statement、commit、rollbackのすべてでJWTの`execute` accessが必要です。

database connectionをrequest間で保持するため、有効期限は短く、同じtransactionへのcommandは直列です。clientが`BEGIN`、`COMMIT`、`ROLLBACK`、`SAVEPOINT`をSQLとして送ることはできません。

## 共通保証

- transaction全体でJWT subject、role、trusted session、policy/schema snapshotを固定する
- statementごとにparse、bind、policy適用、protected SQL再検証を行う
- 以前のstatementによる未commit変更を後続statementから読める
- SQL、policy、check、expect、limitの失敗時はtransaction全体をrollbackする
- commit要求時にcommit checkを実行する

## 開始

```http
POST /v1/transactions HTTP/1.1
Authorization: Bearer <JWT>
PolicySQL-Role: author
Idempotency-Key: 0198f8f1-...
Content-Type: application/json
```

```json
{
  "mode": "write",
  "expected": {
    "schemaVersion": "schema_17",
    "policyVersion": "policy_42"
  }
}
```

対話型transactionでは将来のstatementがまだ存在しないため、`read`または`write`を開始時に指定します。`read`から`write`への切り替えはできません。

```json
{
  "transactionId": "tx_02",
  "status": "active",
  "nextSequence": 1,
  "expiresAt": "2026-08-03T12:00:04Z",
  "meta": {
    "requestId": "req_04",
    "policyVersion": "policy_42",
    "schemaVersion": "schema_17",
    "role": "author"
  }
}
```

`transactionId`だけでは認証情報になりません。後続requestでも同じJWTとroleが必要で、開始時のsession fingerprintと一致しなければ拒否されます。

## Statement

```http
POST /v1/transactions/tx_02/statements HTTP/1.1
Authorization: Bearer <JWT>
PolicySQL-Role: author
Content-Type: application/json
```

```json
{
  "sequence": 1,
  "sql": "SELECT id, status FROM posts WHERE id = :post_id",
  "params": { "post_id": "post_01" },
  "expect": { "rowCount": 1 }
}
```

一回の対話型statement requestは、結果を返して次のcommandを待つ一stepなので、`sql`は正確に一つです。複数を事前に決められる場合はatomic executeの`statements[]`を使用します。

```json
{
  "transactionId": "tx_02",
  "status": "active",
  "nextSequence": 2,
  "result": {
    "columns": ["id", "status"],
    "rows": [
      { "id": "post_01", "status": "draft" }
    ],
    "rowCount": 1,
    "meta": {
      "operation": "select",
      "result": {
        "columns": [
          { "name": "id", "type": "string", "representation": "string", "nullable": false },
          { "name": "status", "type": "string", "representation": "string", "nullable": false }
        ],
        "redactions": []
      }
    }
  },
  "meta": {
    "requestId": "req_05",
    "policyVersion": "policy_42",
    "schemaVersion": "schema_17",
    "role": "author"
  }
}
```

同じtransactionへ異なるcommandを並行送信できません。直前に完了した`sequence`と同一payloadの再送だけは、network retryとして保存済みresponseを返します。異なるpayloadでの再利用、sequenceのskip、古いsequenceはtransactionを失敗させます。

## Commitとrollback

```http
POST /v1/transactions/tx_02/commit HTTP/1.1
Authorization: Bearer <JWT>
PolicySQL-Role: author
Content-Type: application/json
```

```json
{ "sequence": 2 }
```

明示的に破棄する場合は、同じbodyを`POST /v1/transactions/tx_02/rollback`へ送信します。commitとrollbackは同一payloadで再送でき、通信切断後もterminal statusを確定できます。

```json
{
  "transactionId": "tx_02",
  "status": "committed",
  "meta": {
    "requestId": "req_06",
    "policyVersion": "policy_42",
    "schemaVersion": "schema_17",
    "role": "author",
    "commitChecks": "passed"
  }
}
```

commit済みtransactionへのrollback、rollback済みtransactionへのcommitは状態を変更せず、既存のterminal statusを返します。期限までにcommitされなかったtransactionは自動rollbackされます。

## Failure

statement、policy、check、expect、limitのいずれかが失敗するとtransaction全体をrollbackし、`failed`状態にします。失敗後にstatementを追加できません。

validation中は`validating`状態です。この間はcommit-check validatorのSELECTとdecisionだけを受け付け、client commandを拒否します。ownerまたはconnectionを失ったtransactionは別connectionで再構築せず、rollback扱いにします。

## Idempotencyと再送

Atomic Executeでmutationを含むrequestと、対話型transaction開始には`Idempotency-Key`が必要です。keyは検証済みissuer、subject、role、endpointへscopeされ、canonical request hashとterminal responseをCapabilitiesの保存期間中保持します。

- 同じkey、同じpayload、実行中: `POLICYSQL_REQUEST_IN_PROGRESS`
- 同じkey、同じpayload、完了済み: 保存済みstatusとbody
- 同じkey、異なるpayload: `POLICYSQL_IDEMPOTENCY_KEY_REUSED`

timeout後に新しいkeyやsequenceへ進まず、同じrequestを再送して結果を確定します。

## 選び分け

| 条件 | API |
| --- | --- |
| 1件以上のSQLを事前に決められる | Atomic Executeの`statements[]` |
| 直前のresultで次のSQLが変わる | 対話型Transaction |

Atomic ExecuteはHTTP round tripとtransaction保持時間が短く、timeout、owner loss、MVCC conflictの影響を抑えられます。
