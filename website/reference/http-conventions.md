---
title: HTTP共通仕様
description: PolicySQL APIのversion、header、JSON、snapshot、cache、HTTP statusに共通する規則です。
---

# HTTP共通仕様

## API version

public endpointはmajor versionをpathに含めます。この文書のcontractは`/v1`です。field追加など既存clientが無視できる変更はv1内で行い、field削除、型変更、既存意味の変更は新しいmajor pathを使用します。

requestとresponseのmedia typeは`application/json`です。request bodyはUTF-8 JSON objectで、duplicate key、未知field、末尾data、不正Unicode、設定上限を超えるbodyを拒否します。先頭のUTF-8 BOM（`EF BB BF`）は1つだけ受け付けて取り除きます。BOMの3 byteも上限に数えます。2つ目のBOMは不正なJSONとして拒否します。HTTPを使わない入口でも同じ規則です。

## 共通header

| Header | Direction | 意味 |
| --- | --- | --- |
| `Authorization: Bearer` | request | 参考ラッパーのJWT access token。認証方式はdeploymentが決める |
| `PolicySQL-Role` | request | trusted sessionで許可されたroleの選択。省略時はdefault role |
| `Idempotency-Key` | request | 任意。更新・対話型開始の再送識別子。指定時は16〜128文字の英数字と`._:-` |
| `Traceparent` | request | 任意のW3C trace context。認可情報には使用しない |
| `PolicySQL-Request-Id` | response | serverが生成した問い合わせ識別子 |
| `ETag` | response | CatalogまたはCapabilities representationのcache validator |
| `Retry-After` | response | ラッパーが返す`429`で、再送まで待つ秒数。ライブラリはどのresponseにも付けない |

同名security headerが複数あるrequest、comma結合されたroleやbearer token、改行を含む値は拒否します。request IDはラッパーが渡す値か、なければHTTP adapterが生成する値です。ライブラリはplatformのheader（`cf-ray`など）を読みません。client指定値を監査上の識別子として信用しません。

## JSON parameter

`params`はparameter名をkeyとするobjectです。値にはJSON `null`、boolean、finite number、string、object、arrayを使用できます。objectとarrayはtarget descriptorがJSONの場合だけ、stringはTEXT、format付きstring、int64、bytesなどexpected descriptorに従って検証されます。

named parameterへのJSON `null`は、そのparameterのすべての出現箇所が、Catalogで`nullable: true`と宣言された列へのINSERT `VALUES`／UPDATE `SET`の直接代入（値全体がparameter）である場合だけSQL NULLとしてbindします。型はstring、number、integer、boolean、json、bytes、日付系のいずれでも同じです。同じparameterを非nullable列への代入、比較、`IN`、`LIKE`、関数、`CASE`、`ORDER BY`、`LIMIT`／`OFFSET`で再利用した場合はNULLを受け付けず、それ以外のJSON `null`は400 `POLICYSQL_INVALID_PARAMETER`で拒否します（database接続前）。json列では`null`はJSON文字列`null`ではなくSQL NULLです。列権限、preset、tenant filter、RETURNING権限、TRUEだけを成功とするpost-state checkはNULLを書き込む行にもそのまま適用され、NULLによって比較がUNKNOWNになるcheckは失敗します。SQLの`NULL` literalは引き続き未対応で、保存済みNULLの照会には`column IS NULL`を使用します。Explainのparameter descriptorの`nullable`はこの判定そのもので、Executeが受け付ける範囲と常に一致します。

SQLite BLOBはtarget descriptorが`bytes / string / base64`のときにbase64 stringとして送ります。parameter値だけから型を推測せず、SQLの利用箇所とcompiled Catalogからexpected descriptorを決定します。

## bytesの入出力

bytesは配備先に依存しないPolicySQL共通のJSON契約です。INSERT／UPDATEのparameterとSELECT／RETURNINGの結果は、標準alphabet（`+/`）、必要なpadding、未使用bitが0のcanonical base64 stringを使用します。空白、改行、base64url、省略padding、配列、DB driver固有objectはbytes入力として拒否します。空bytesは`""`、nullable列の結果に含まれるSQL NULLは`null`です。bytes parameterへのJSON `null`は他の型と同じく、次のNULL parameterの規則に従います。

```json
{
  "statements": [{
    "sql": "INSERT INTO blobrows(id,state) VALUES(:id,:state) RETURNING id,state",
    "params": { "id": "bytes-1", "state": "AAEC/w==" }
  }]
}
```

`state`がbytesなら`00 01 02 ff`の物理BLOBとして保存され、結果も`"AAEC/w=="`です。同じ文字列をstring列へ渡すとTEXTとして保存します。DBがbytes列の値としてTEXTを返した場合は、base64として正しくてもschema mismatchで拒否します。

SELECT／RETURNINGが返すbytes値も必ずこのcanonical base64表現なので、取得した値をbytes parameterへそのまま再送できます。DB通信でpaddingが省略されていても、公開APIからは必要なpaddingを付けて返します。

復号後の1値の上限はCapabilitiesの`limits.maxBytesPerValue`で確認します。初期profileは262,144 byte（256 KiB）です。request body、結果、transactionの上限も個別に適用します。base64は`4 × ceil(byte数 / 3)`文字になるため、既定の結果上限64,000 byteではJSONの分を差し引いて合計48,000 byte未満の生bytesを返せます。書き込めるサイズでもRETURNINGの上限を超える場合があり、その場合はcommit前にrollbackします。

不正encoding／誤型は400 `POLICYSQL_INVALID_PARAMETER`、復号後サイズ超過は413 `POLICYSQL_LIMIT_EXCEEDED`です。巨大な入力でもencodingが不正なら400です。DBに保存済みの物理BLOBが上限を超える場合もtransportによらず413となり、transactionをrollbackします（再試行可能な503にはしません）。ClientへCloudflareの上限を固定せず、接続先のCapabilitiesを使用してください。row／column policy、RETURNING permission、transaction／replayの規則は通常のSQLと共通です。

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
| `401` | credentialがない、無効、期限切れ。ライブラリではなくラッパーが返す |
| `403` | role、resource、operation、column、policyによる拒否 |
| `404` | 公開可能な範囲でtransactionなどが存在しない |
| `409` | stale snapshot、idempotency conflict、transaction state conflict、commit conflict |
| `413` | request bodyまたはSQL textが上限超過 |
| `422` | type、format、constraint、operation check、expectationの不成立 |
| `429` | ラッパーのrate limit（`POLICYSQL_RATE_LIMITED`）、ライブラリのusage budget・transaction上限 |
| `500` | 安全に公開できない内部失敗 |
| `503` | database、transaction owner、commit-check serviceなど一時的な依存先障害 |
| `504` | compile、database、hookのtimeout |

request rateの制限はラッパーの責務です。ライブラリは`POLICYSQL_RATE_LIMITED`を返さず、limiterのbindingも必要としません。ラッパーは`app.fetch`より前に制限し、`createErrorResponse`で同じerror形式の429を返します。参考実装の429には`Retry-After: 60`が付きます。詳細は[エラー](../api/errors#ラッパーが返すエラー)を参照してください。

各codeのstatusは1つだけで、対応表は[エラー](../api/errors#error-codeとhttp-status)が正本です。HTTP adapterはこの表だけを持ちます。

認可対象の存在を秘匿する必要がある場合、`403`と`404`を同じ公開errorへ正規化できます。clientはHTTP statusだけでなく安定したerror `code`を使用します。

## Cache

Catalogは`schemaVersion`、`policyVersion`、roleで異なり、認証済みprivate responseです。`Cache-Control: private, no-cache`と`ETag`を返し、clientは`If-None-Match`で再検証できます。shared CDNへ認証済みCatalogを保存しません。

Capabilitiesはdeployment contractです。認証を要求し、短いprivate cacheと`ETag`を使用できます。policy permissionはCapabilitiesに含まれません。

## Machine-readable contract

配布物の[OpenAPI 3.1 document](/spec/openapi.yaml)がHTTP shapeのmachine-readable contractです。Atomic Execute request、policy、JWT claims、Catalog、Catalog manifestは[/spec/schemas/](/spec/schemas/policy.schema.json)以下のJSON Schemaとして配布します。文書とschemaが食い違う場合は同じreleaseを不正として扱い、片方だけを推測して実装しません。
