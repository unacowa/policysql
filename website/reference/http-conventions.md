---
title: HTTP共通仕様
description: PolicySQL APIのversion、header、JSON、snapshot、cache、HTTP statusに共通する規則です。
---

# HTTP共通仕様

## API version

public endpointはmajor versionをpathに含めます。この文書のcontractは`/v1`です。field追加など既存clientが無視できる変更はv1内で行い、field削除、型変更、既存意味の変更は新しいmajor pathを使用します。

requestとresponseのmedia typeは`application/json`です。request bodyはUTF-8 JSON objectで、duplicate key、未知field、末尾data、不正Unicode、設定上限を超えるbodyを拒否します。

## 共通header

| Header | Direction | 意味 |
| --- | --- | --- |
| `Authorization: Bearer` | request | JWT access token |
| `PolicySQL-Role` | request | JWTで許可されたroleの選択。省略時はdefault role |
| `Idempotency-Key` | request | write requestの再送識別子 |
| `Traceparent` | request | 任意のW3C trace context。認可情報には使用しない |
| `PolicySQL-Request-Id` | response | serverが生成した問い合わせ識別子 |
| `ETag` | response | CatalogまたはCapabilities representationのcache validator |
| `Retry-After` | response | `429`または一時的な`503`で再送可能になる目安 |

同名security headerが複数あるrequest、comma結合されたroleやbearer token、改行を含む値は拒否します。request IDはserverが生成し、client指定値を監査上の識別子として信用しません。

## JSON parameter

`params`はparameter名をkeyとするobjectです。値にはJSON `null`、boolean、finite number、string、object、arrayを使用できます。objectとarrayはtarget descriptorがJSONの場合だけ、stringはTEXT、format付きstring、int64、bytesなどexpected descriptorに従って検証されます。

SQLite BLOBはtarget descriptorが`bytes / string / base64`のときにbase64 stringとして送ります。parameter値だけから型を推測せず、SQLの利用箇所とcompiled Catalogからexpected descriptorを決定します。

## Snapshot precondition

Atomic Execute requestとtransaction開始requestには、任意の`expected`を指定できます。Atomic Executeではrequest全体のsnapshotを固定するため、`expected`は`statements[]`の外側に置きます。

```json
{
  "expected": {
    "schemaVersion": "schema_18",
    "policyVersion": "policy_42"
  },
  "statements": [
    {
      "sql": "SELECT id, title FROM posts",
      "params": {}
    }
  ]
}
```

現在のsnapshotと一致しない場合は、SQLを実行せず`POLICYSQL_STALE_OPERATION`を返します。公式clientとgenerated codeはCatalog取得時の両versionを送信します。省略時はrequest開始時のcurrent snapshotを使用します。

transaction開始後はsnapshotが固定され、statementごとの`expected`は指定しません。snapshotを維持できないpolicyまたはschema更新が発生した場合、active transactionをfail closedで終了します。

## HTTP status

| Status | 用途 |
| --- | --- |
| `200` | SQL、transaction command、Catalog、Capabilitiesの成功 |
| `201` | 新しいinteractive transactionの開始 |
| `400` | malformed JSON、SQL、parameter、sequenceなどrequestの不正 |
| `401` | JWTがない、無効、期限切れ |
| `403` | role、resource、operation、column、policyによる拒否 |
| `404` | 公開可能な範囲でtransactionなどが存在しない |
| `409` | stale snapshot、idempotency conflict、transaction state conflict、commit conflict |
| `413` | request bodyまたはSQL textが上限超過 |
| `422` | type、format、constraint、operation check、expectationの不成立 |
| `429` | rate limit |
| `500` | 安全に公開できない内部失敗 |
| `503` | database、transaction owner、commit-check serviceなど一時的な依存先障害 |
| `504` | compile、database、hookのtimeout |

認可対象の存在を秘匿する必要がある場合、`403`と`404`を同じ公開errorへ正規化できます。clientはHTTP statusだけでなく安定したerror `code`を使用します。

## Cache

Catalogは`schemaVersion`、`policyVersion`、roleで異なり、認証済みprivate responseです。`Cache-Control: private, no-cache`と`ETag`を返し、clientは`If-None-Match`で再検証できます。shared CDNへ認証済みCatalogを保存しません。

Capabilitiesはdeployment contractです。認証を要求し、短いprivate cacheと`ETag`を使用できます。policy permissionはCapabilitiesに含まれません。

## Machine-readable contract

配布物の[OpenAPI 3.1 document](/spec/openapi.yaml)がHTTP shapeのmachine-readable contractです。Atomic Execute request、policy、JWT claims、Catalog、Catalog manifestは[/spec/schemas/](/spec/schemas/policy.schema.json)以下のJSON Schemaとして配布します。文書とschemaが食い違う場合は同じreleaseを不正として扱い、片方だけを推測して実装しません。
