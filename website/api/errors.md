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

## 主なerror code

| Code | 意味 |
| --- | --- |
| `POLICYSQL_INVALID_REQUEST` | JSONや必須fieldが不正 |
| `POLICYSQL_UNAUTHENTICATED` | JWTがない、または検証できない |
| `POLICYSQL_FORBIDDEN_ROLE` | 選択したroleがJWTで許可されていない |
| `POLICYSQL_FORBIDDEN_ACCESS` | JWTがendpointに必要なaccessを持たない |
| `POLICYSQL_INVALID_SQL` | SQLをparseできない |
| `POLICYSQL_MULTIPLE_STATEMENTS` | statementが複数含まれる |
| `POLICYSQL_UNSUPPORTED_SQL` | 対応範囲外の構文 |
| `POLICYSQL_MISSING_POLICY` | 適用可能なpolicyがない |
| `POLICYSQL_FORBIDDEN_OPERATION` | operationが許可されていない |
| `POLICYSQL_FORBIDDEN_COLUMN` | 利用できないcolumnを参照した |
| `POLICYSQL_FORBIDDEN_COLUMN_CONTEXT` | 条件付き出力列をprojection以外で参照した |
| `POLICYSQL_DUPLICATE_RESULT_COLUMN` | alias適用後のresult column名が重複した |
| `POLICYSQL_INVALID_PARAMETER` | parameterの不足、型、値が不正 |
| `POLICYSQL_AMBIGUOUS_PARAMETER_TYPE` | Explainでparameter型を一意に証明できない |
| `POLICYSQL_RESERVED_PARAMETER` | server用のparameter名を使用した |
| `POLICYSQL_PRESET_COLUMN` | clientがserver-owned columnを指定した |
| `POLICYSQL_CHECK_FAILED` | mutation後のrowがpolicy checkを満たさない |
| `POLICYSQL_COMMIT_CHECK_REJECTED` | commit checkがtransactionを拒否した |
| `POLICYSQL_COMMIT_CHECK_UNAVAILABLE` | commit checkを安全に完了できない |
| `POLICYSQL_COMMIT_CHECK_QUERY` | validatorのcallback SELECTを許可または実行できない |
| `POLICYSQL_LIMIT_EXCEEDED` | requestまたはresult limitを超えた |
| `POLICYSQL_REQUEST_TOO_LARGE` | HTTP bodyまたはSQL textが受付上限を超えた |
| `POLICYSQL_RATE_LIMITED` | request rate limitを超えた（HTTP 429）。ライブラリではなくラッパーが返す。[ラッパーが返すエラー](#ラッパーが返すエラー)を参照 |
| `POLICYSQL_TIMEOUT` | compileまたはdatabase実行がtimeoutした |
| `POLICYSQL_STALE_OPERATION` | policyまたはcatalog versionが古い |
| `POLICYSQL_SCHEMA_MISMATCH` | database値がcompiled logical contractと一致しない |
| `POLICYSQL_DATABASE_UNAVAILABLE` | database adapterまたはtransaction ownerを利用できない |
| `POLICYSQL_DATABASE_TIMEOUT` | DB接続準備・実行・commit確認の期限を超えた（HTTP 504） |
| `POLICYSQL_DATABASE_REQUIRED` | ラッパーが必須のDB引数を渡していない（HTTP 500） |
| `POLICYSQL_DATABASE_BINDING_REJECTED` | DB bindingが不正、未登録、または現在の経路設定で許可されていない |
| `POLICYSQL_COMMIT_CONFLICT` | MVCC conflictによりcommitできなかった |
| `POLICYSQL_TRANSACTION_NOT_FOUND` | transactionが存在しないか、利用者に属していない |
| `POLICYSQL_TRANSACTION_EXPIRED` | transactionの有効期限を超えた |
| `POLICYSQL_TRANSACTION_SEQUENCE` | 対話型operationの順序が一致しない |
| `POLICYSQL_TRANSACTION_FAILED` | transactionが失敗状態になり継続できない |
| `POLICYSQL_EXPECTATION_FAILED` | transaction operationの期待条件を満たさない |
| `POLICYSQL_IDEMPOTENCY_KEY_REQUIRED` | 明示されたkeyが空または形式不正。省略時には発生しない（互換性のため既存codeを維持） |
| `POLICYSQL_IDEMPOTENCY_CONFLICT` | 通常atomicで同じkeyが異なるrequestに使われた |
| `POLICYSQL_REQUEST_IN_PROGRESS` | 同じidempotency keyのrequestがまだ実行中 |
| `POLICYSQL_INTERNAL` | 公開できない内部エラー |

`POLICYSQL_USAGE_BUDGET_EXCEEDED`（queryの推定usageが予算を超えた）と`POLICYSQL_TRANSACTION_LIMIT_EXCEEDED`（transactionの上限を超えた）も、ライブラリがHTTP 429で返します。これらはrequest rateの制限ではありません。

error codeはAPI versionごとの安定したcontractです。minor releaseで既存codeの意味を変更しません。

## ラッパーが返すエラー

レート制限はライブラリの機能ではなく、実装側（ラッパー）の責務です。ラッパーはWorkerの`fetch`で`app.fetch`より前にrequestを判定し、上限を超えた場合は`POLICYSQL_RATE_LIMITED`（HTTP 429）を返します。キー（IP、token、ラッパーが判定したtenantなど）と制限基盤もラッパーが決めます。ライブラリはlimiterのbindingを読まず、bindingがなくても全endpointが動作します。

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

不正な引数は`TypeError`になります。参考実装（`deploy/cloudflare/wrapper/`、`examples/database-routing/`）は、Cloudflare Rate Limiting binding `RATE_LIMITER`を使い、上限超過時に`Retry-After: 60`（bindingの`period`秒）を付けて429を返します。このとき、JWT検証、WASMの初期化、SQL compile、DB接続は行いません。bindingがない、またはbindingが例外を投げた場合は、`app.fetch`を呼ばずにHTTP 500 `POLICYSQL_INTERNAL`を返します（fail closed）。

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
