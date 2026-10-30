---
title: エラー
description: PolicySQLのerror responseと安全な処理方法です。
---

# エラー

失敗時は、共通形式のerror responseを返します。

```json
{
  "error": {
    "code": "POLICYSQL_FORBIDDEN_COLUMN",
    "message": "The statement references a column that is not available for this operation.",
    "path": null,
    "requestId": "req_01"
  }
}
```

## Field

| Field | Description |
| --- | --- |
| `code` | programから判定する安定したerror code |
| `message` | 利用者向けの安全な説明。診断情報を含まない |
| `path` | request body内の問題箇所。特定できない場合は`null` |
| `requestId` | server logと照合する識別子 |

clientは`message`ではなく`code`を使って分岐してください。

HTTP statusとの対応、request ID header、retry規則は[HTTP共通仕様](../reference/http-conventions)を参照してください。`path`は可能な場合にrequest bodyへのRFC 6901 JSON Pointerを返します。

## Error codeとHTTP status

この表が、ライブラリが返すerror codeとHTTP statusの対応の正本です。HTTP adapter（`deploy/cloudflare/src/http/status.ts`）はこの表と同じ対応だけを持ち、ライブラリのコード（TypeScriptとRust）が返し得るcodeはすべてこの表にあり、逆にこの表のcodeはすべてライブラリのどこかが実際に返します（どちらもテストで確認します）。予約codeは現在ありません。engineの操作（[HTTPを使わない入口](../admin/operations-api)）はHTTP statusを返さず、同じ`code`を返します。表にないcodeはライブラリの不具合で、HTTPでは500になります。

<!-- policysql:error-status-table:library -->
| Code | Status | 意味 |
| --- | --- | --- |
| `POLICYSQL_INVALID_REQUEST` | 400 | JSON、必須field、header（`PolicySQL-Role`の複数指定など）が不正 |
| `POLICYSQL_INVALID_SQL` | 400 | SQLをparseできない |
| `POLICYSQL_MULTIPLE_STATEMENTS` | 400 | statementが複数含まれる |
| `POLICYSQL_UNSUPPORTED_SQL` | 400 | 対応範囲外の構文 |
| `POLICYSQL_DUPLICATE_RESULT_COLUMN` | 400 | alias適用後のresult column名が重複した |
| `POLICYSQL_INVALID_PARAMETER` | 400 | parameterの不足、型、値が不正 |
| `POLICYSQL_AMBIGUOUS_PARAMETER_TYPE` | 400 | Explainでparameter型を一意に証明できない |
| `POLICYSQL_RESERVED_PARAMETER` | 400 | server用のparameter名を使用した |
| `POLICYSQL_IDEMPOTENCY_KEY_REQUIRED` | 400 | 明示されたkeyが空または形式不正。省略時には発生しない（互換性のため既存codeを維持） |
| `POLICYSQL_FORBIDDEN_ACCESS` | 403 | `PolicySQL-Role`がtrusted sessionの`roles`にない、またはendpointに必要なaccessがない |
| `POLICYSQL_MISSING_POLICY` | 403 | 適用可能なpolicyがない |
| `POLICYSQL_FORBIDDEN_OPERATION` | 403 | operationが許可されていない |
| `POLICYSQL_FORBIDDEN_COLUMN` | 403 | 利用できないcolumnを参照した |
| `POLICYSQL_FORBIDDEN_COLUMN_CONTEXT` | 403 | 条件付き出力列をprojection以外で参照した |
| `POLICYSQL_PRESET_COLUMN` | 403 | clientがserver-owned columnを指定した |
| `POLICYSQL_TRANSACTION_MODE_VIOLATION` | 403 | read transactionでmutationを実行しようとした |
| `POLICYSQL_DATABASE_BINDING_REJECTED` | 403 | DB bindingが不正、未登録、または現在の経路設定で許可されていない |
| `POLICYSQL_NOT_FOUND` | 404 | endpointが存在しない |
| `POLICYSQL_STALE_OPERATION` | 409 | policyまたはcatalog versionが古い |
| `POLICYSQL_IDEMPOTENCY_CONFLICT` | 409 | Atomic Execute（commit checkを行うDO経路を含む）で同じkeyが異なるrequest（payloadまたはDBのgenerationが違う）に使われた。deployでsnapshotが変わっただけの再送は衝突しない |
| `POLICYSQL_TRANSACTION_CONFLICT` | 409 | 対話型transactionのcommandが現在の状態（sequenceなど）と矛盾する |
| `POLICYSQL_TRANSACTION_UNAVAILABLE` | 409 | transactionが存在しない、利用者に属していない、期限切れ、または失敗状態 |
| `POLICYSQL_COMMIT_CHECK_REJECTED` | 409 | commit checkがtransactionを拒否した、または安全に完了できない |
| `POLICYSQL_LIMIT_EXCEEDED` | 413 | requestまたはresult limitを超えた |
| `POLICYSQL_REQUEST_TOO_LARGE` | 413 | HTTP bodyまたはSQL textが受付上限を超えた |
| `POLICYSQL_UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type`が`application/json`でない |
| `POLICYSQL_EXPECTATION_FAILED` | 422 | transaction operationの期待条件を満たさない |
| `POLICYSQL_SCHEMA_MISMATCH` | 422 | database値がcompiled logical contractと一致しない |
| `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED` | 429 | transactionの上限を超えた（request rateの制限ではない） |
| `POLICYSQL_INTERNAL` | 500 | 公開できない内部エラー。ラッパーが渡したtrusted sessionや文脈の形が不正な場合もこのcode |
| `POLICYSQL_DATABASE_REQUIRED` | 500 | ラッパーが必須のDB引数を渡していない |
| `POLICYSQL_DATABASE_UNAVAILABLE` | 503 | database adapterまたはtransaction ownerを利用できない |
| `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` | 503 | commitを送った後に結果を確定できない（transaction ownerの喪失、ownerの記録の保存失敗、COMMIT中の通信エラー）。commit済みの可能性があるため、拒否ではなく結果不明として扱う |
| `POLICYSQL_TIMEOUT` | 504 | database実行がtimeoutした |
| `POLICYSQL_DATABASE_TIMEOUT` | 504 | DB接続準備・実行・commit確認の期限を超えた |

error codeはAPI versionごとの安定したcontractです。minor releaseで既存codeの意味やstatusを変更しません。以前この頁に載っていた`POLICYSQL_FORBIDDEN_ROLE`、`POLICYSQL_CHECK_FAILED`、`POLICYSQL_COMMIT_CHECK_UNAVAILABLE`、`POLICYSQL_COMMIT_CHECK_QUERY`、`POLICYSQL_COMMIT_CONFLICT`、`POLICYSQL_TRANSACTION_NOT_FOUND`、`POLICYSQL_TRANSACTION_EXPIRED`、`POLICYSQL_TRANSACTION_SEQUENCE`、`POLICYSQL_TRANSACTION_FAILED`、`POLICYSQL_REQUEST_IN_PROGRESS`は、どのコードも返したことがないため削除しました。役割の拒否は`POLICYSQL_FORBIDDEN_ACCESS`、transactionの不在・期限切れ・失敗は`POLICYSQL_TRANSACTION_UNAVAILABLE`、sequenceの不一致は`POLICYSQL_TRANSACTION_CONFLICT`です。

この表にあった`POLICYSQL_COST_UNKNOWN`（403）、`POLICYSQL_USAGE_BUDGET_EXCEEDED`（429）、`POLICYSQL_COST_ADMISSION_UNAVAILABLE`（503）は、costの見積もりがrequestの受付を判定しない観測になってから、どのresponseにも現れていません。見積もりのlogにだけ現れるため、下の「logだけに現れるcode」へ移しました。clientもこれらを拒否として扱いません。

## logだけに現れるcode

次のcodeはerror responseには現れず、構造化logの`code`にだけ現れます。HTTP statusはありません。公開exportの`statusFor`はこれらに表外のcodeと同じ500を返し（以前は表のstatus）、`ERROR_STATUS`にも含まれません。`createErrorResponse`はどのstatusでもこれらのcodeを`TypeError`にします。

<!-- policysql:log-code-table -->
| Code | Log event | 意味 |
| --- | --- | --- |
| `POLICYSQL_COST_UNKNOWN` | `cost_observation_failed` | queryのcostを安全に見積もれない（`costCatalog`がない、catalogにないresourceを参照した、planの行が想定の形でない） |
| `POLICYSQL_USAGE_BUDGET_EXCEEDED` | `cost_observation_failed` | queryの推定usageが`costCatalog`の予算を超えた。requestは拒否されない |
| `POLICYSQL_COST_ADMISSION_UNAVAILABLE` | `cost_observation_failed` | cost見積もり用のdatabase接続や見積もりが失敗した |

cost見積もりはcommit後（direct placementのreplayを含む）に別のread接続で背景実行され、requestの結果には影響しません（[ラッパーからDBを渡す](../admin/database-routing)の`PolicySqlConfig.costCatalog`）。

## ラッパーが返すエラー

次のcodeはライブラリではなくラッパーが返します。statusはこの表のとおりです（`createErrorResponse`は、ライブラリの表にあるcodeを別のstatusで作ろうとすると`TypeError`にします）。

<!-- policysql:error-status-table:wrapper -->
| Code | Status | 意味 |
| --- | --- | --- |
| `POLICYSQL_UNAUTHENTICATED` | 401 | credentialがない、または無効・期限切れ・失効。ラッパーが返す401の標準code。参考ラッパーとJWT adapterはこのcodeだけを使う |
| `POLICYSQL_AUTHENTICATION_FAILED` | 401 | 予約code。同梱のコードはどれも返さない。独自のラッパーが「credentialはあるが検証に失敗した」を、credentialがない場合と区別したいときに使える。clientは`POLICYSQL_UNAUTHENTICATED`と同じく「実行されていない」拒否として扱う |
| `POLICYSQL_RATE_LIMITED` | 429 | request rate limitを超えた |

認証はライブラリの機能ではなく、ラッパーの責務です（[JWT認証](../security/jwt)）。ラッパーはcredentialを検証し、失敗した場合は`app.fetch`を呼ばずにHTTP 401を返します。標準codeは`POLICYSQL_UNAUTHENTICATED`です（参考実装はこれだけを返す）。`POLICYSQL_AUTHENTICATION_FAILED`は予約codeで、独自のラッパーが「credentialはあるが検証に失敗した」場合を区別したいときだけ使います。ライブラリは401を返しません。対話型transactionのcommandとcommitも毎回認証するため、token失効や期限切れの後はtransactionを継続できません。

レート制限もライブラリの機能ではなく、実装側（ラッパー）の責務です。ラッパーはWorkerの`fetch`で`app.fetch`より前にrequestを判定し、上限を超えた場合は`POLICYSQL_RATE_LIMITED`（HTTP 429）を返します。キー（IP、token、ラッパーが判定したtenantなど）と制限基盤もラッパーが決めます。ライブラリはlimiterのbindingを読まず、bindingがなくても全endpointが動作します。

ラッパーが返すエラーも同じ形式にするため、`@unacowa/policysql/cloudflare`は`createErrorResponse`を公開しています。

```ts
import { createErrorResponse } from "@unacowa/policysql/cloudflare";

return createErrorResponse(429, "POLICYSQL_RATE_LIMITED", "Too many requests.", {
  requestId: request.headers.get("cf-ray") ?? undefined,
  headers: { "retry-after": "60" },
});
```

| 引数 | 内容 |
| --- | --- |
| `status` | 400〜599の整数 |
| `code` | `POLICYSQL_[A-Z0-9_]+`に一致するcode |
| `message` | 空でない安全な説明 |
| `path` | 任意。省略時は`null` |
| `requestId` | 任意。省略時はUUIDを生成 |
| `headers` | 任意の追加header。`cache-control: no-store`、JSONの`content-type`、`x-content-type-options: nosniff`は上書きできない |

不正な引数は`TypeError`になります。参考実装（`deploy/cloudflare/wrapper/`、`examples/database-routing/`）は、すべてのrequestをライブラリより前に制限します。clientのrequestはCloudflare Rate Limiting binding `RATE_LIMITER`、commit checkのcallbackは別のbinding `CALLBACK_RATE_LIMITER`（別のkey）で数えます。callbackのcapabilityはtransaction ownerの中でしか検証されません。そのため制限しないと、認証なしでbodyの読み込み、Durable Objectの参照、storageの読み込みを繰り返し実行させられます。bucketを分けているので、clientのrequestが多くてもvalidatorのcallbackは制限されません。

上限超過時は`Retry-After: 60`（bindingの`period`秒）を付けて429を返します。このとき、認証、WASMの初期化、SQL compile、Durable Object、DB接続は行いません。bindingがない、またはbindingが例外を投げた場合は、ライブラリを呼ばずにHTTP 500 `POLICYSQL_INTERNAL`を返します（fail closed）。

## 情報を公開しないエラー

次の情報はclient responseへ含めません。

- 非公開resourceやcolumnの一覧
- policy predicateの内容
- sessionのsecretやserver-owned parameter値
- database credential
- commit checkのhook認証情報とopaque capability
- remote databaseのraw error

運用者は`requestId`を使い、アクセス制限されたserver logで詳細を調査します。

## Retry

SQL・policy・parameter errorは、同じrequestを再送しても成功しません。requestを修正してください。timeout、rate limit、一時的なadapter error、commit conflictのretryは上限とbackoffを設けます。ライブラリはどのresponseにも`Retry-After`を付けません。ラッパーが429に`Retry-After`を付けた場合は、その秒数以上待ってから再送します。初回からkeyを指定したwriteの再送には、同じidempotency keyと同じpayloadを使用し、結果が確定する前に新しいkeyで再実行しません。keyなしのwriteは重複排除を保証しないため、結果不明時に自動再送すると二重更新になり得ます。
