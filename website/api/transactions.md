---
title: 対話型Transaction API
description: 途中結果から次のSQLを決めるための短時間transaction lifecycleです。
---

# 対話型Transaction API

通常の単一・複数statementは[Atomic Execute API](./execute)を使用します。対話型transactionは、直前のresultをapplicationで確認しなければ次のstatementを構築できない場合だけ使用します。

開始、statement、commit、rollbackのすべてでtrusted sessionの`execute` accessが必要です。ラッパーはこれらのrequestを毎回認証します。

database connectionをrequest間で保持するため、有効期限は短く、同じtransactionへのcommandは直列です。clientが`BEGIN`、`COMMIT`、`ROLLBACK`、`SAVEPOINT`をSQLとして送ることはできません。

## 共通保証

- transaction全体でprincipal、subject、role、trusted session、policy/schema snapshotを固定する
- statementごとにparse、bind、policy適用、protected SQL再検証を行う
- 以前のstatementによる未commit変更を後続statementから読める
- SQL、policy、check、expect、limitの失敗時はtransaction全体をrollbackする
- commit要求時にcommit checkを実行する

## 開始

```http
POST /v1/transactions HTTP/1.1
Authorization: Bearer <JWT>
PolicySQL-Role: author
Idempotency-Key: 0198f8f1-0f64-7000-8000-000000000001
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

`transactionId`だけでは認証情報になりません。後続requestでも同じprincipal、subject、role、sessionが必要で、開始時のsession fingerprintと一致しなければ拒否されます。token失効や期限切れの後にcommandとcommitを止めるのはラッパーの責務です（参考ラッパーは毎回JWTを検証し、失敗すれば401を返します）。

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

terminal status の再確認は、直前と同じ command（commit または rollback）、同じ sequence、同じ payload の再送で行います。反対の terminal command は再送として扱わず拒否します。HTTP 200 だけで commit 成功を判断せず、`status: committed` を確認してください。`failed` は rollback 完了の保証ではありません。期限までに commit されなかった transaction は自動 rollback されます。

COMMIT を送った後に結果を確定できない場合、commit とその再送は HTTP 503 `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` になります。COMMIT を送る前の失敗（ownerの喪失、期限切れ、commit checkの拒否、COMMIT直前のbindingまたは期限の確認の失敗など）は、従来どおり確定的な拒否（409）です。ownerはCOMMITを送る前に`committing`状態を保存し、commit後の状態（`committed`、次のsequence、保存済みresponse）を1回の書き込みで保存します。そのため、COMMITの送信後にownerを失った場合や記録の保存に失敗した場合でも、commitの再送が409で拒否されることはありません。deployで snapshot が変わった後の commit の再送も同様です（同じ principal・subject・role・session・database（scope、ID、generation）で、違いが snapshot だけの場合。commit 以外の command は現在の snapshot が必要で、別の principal や database からの再送は従来どおり拒否します）。`POLICYSQL_COMMIT_OUTCOME_UNKNOWN` は commit 済みの可能性があるため、別 transaction でやり直す前に、アプリケーションのデータで結果を確認してください。

## Failure

statement、policy、check、expect、limitのいずれかが失敗するとtransaction全体をrollbackし、`failed`状態にします。失敗後にstatementを追加できません。

validation中は`validating`状態です。この間はcommit-check validatorのSELECTとdecisionだけを受け付け、client commandを拒否します。ownerまたはconnectionを失ったtransactionは別connectionで再構築せず、rollback扱いにします。

## Idempotencyと再送

Atomic Executeでmutationを含むrequestと、対話型transaction開始の`Idempotency-Key`は任意です。指定したkeyはtrusted sessionのprincipal、subject、role、session、endpoint、DB識別子へ束縛し、canonical request hashにはDB binding（version、scope、ID、generation。deployごとに変わるsnapshotは含めません）も含めます。保存済みの結果がある場合、同一要求へその結果を返します。

- 同じkey、同じpayload、完了済み: 保存済みstatusとbody。ABI・policy・schemaの変更でsnapshotが変わるdeployの後の再送も同じです（commit済みの書き込みを再実行せず、元の結果を返します。`meta.policyVersion`と`meta.schemaVersion`は応答したdeployの値です）。ただし、ABI 9より前のreleaseが保存した結果はsnapshotを含むhashで記録されているため、deploy後の再送は1回限りの非互換として`POLICYSQL_IDEMPOTENCY_CONFLICT`になります（再実行はしません）
- 同じkey、異なるpayloadまたは経路世代: HTTP 409（Atomic Executeはcommit checkを行うDO経路を含めて`POLICYSQL_IDEMPOTENCY_CONFLICT`、対話型transaction開始は`POLICYSQL_TRANSACTION_CONFLICT`）
- keyなしのAtomic Execute: 要求ごとに実行し、`policysql_idempotency`を参照・追記しない
- keyなしの対話型transaction開始: 毎回新しいtransaction ID／ownerを作る

対話型transactionはDOに状態を保存し、キーの有無にかかわらず利用DBの冪等性テーブルは不要です。開始後のstatement・commit・rollbackは、同じtransaction IDとsequenceによる既存の再送規則を維持します。

開始時に返された`transactionId`で、statement・commit・rollbackをすべて同じ担当DOへ振り分けます。commit checkのcallbackも、そのDOが保持する同じDBトランザクションへ届きます。「キーなしでは毎回別ID」は開始要求ごとの意味であり、開始後のSQLやcallbackごとに担当DOが変わることはありません。

キーを使用した場合、timeout後に新しいkeyやsequenceへ進まず、同じrequestを再送して結果を確定します。キーなしの開始要求を再送しても以前のtransactionは取得できず、別のtransactionになります。キーなしのAtomic Executeの再送には重複排除の保証がありません。

## 選び分け

| 条件 | API |
| --- | --- |
| 1件以上のSQLを事前に決められる | Atomic Executeの`statements[]` |
| 直前のresultで次のSQLが変わる | 対話型Transaction |

Atomic ExecuteはHTTP round tripとtransaction保持時間が短く、timeout、owner loss、MVCC conflictの影響を抑えられます。
