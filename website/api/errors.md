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
| `message` | codeごとの固定文。DBやparserの文言を含まない |
| `path` | request body内の問題箇所。特定できない場合は`null` |
| `detail` | 任意。codeごとに決まった機械可読の値（固定の列挙値と数値だけ。DBやparserの文言・識別子は含まない）。現在は`POLICYSQL_CONSTRAINT_VIOLATION`の`constraint`と、`POLICYSQL_OUTCOME_UNKNOWN`の`cause`（`code`と`path`）だけ。分岐の主キーは`code` |
| `requestId` | server logと照合する識別子 |

clientは`message`ではなく`code`を使って分岐してください。

HTTP statusとの対応、request ID header、retry規則は[HTTP共通仕様](../reference/http-conventions)を参照してください。`path`は可能な場合にrequest bodyへのRFC 6901 JSON Pointerを返します。

## Error codeとHTTP status

この表が、ライブラリが返すerror codeとHTTP statusの対応の正本です。HTTP adapter（`deploy/cloudflare/src/http/status.ts`）はこの表と同じ対応だけを持ち、ライブラリのコード（TypeScriptとRust）が返し得るcodeはすべてこの表にあり、逆にこの表のcodeはすべてライブラリのどこかが実際に返します（どちらもテストで確認します）。予約codeは現在ありません。engineの操作（[HTTPを使わない入口](../admin/operations-api)）はHTTP statusを返さず、同じ`code`を返します。表にないcodeはライブラリの不具合で、HTTPでは500になります。

<!-- policysql:error-status-table:library -->
| Code | Status | 意味 |
| --- | --- | --- |
| `POLICYSQL_INVALID_REQUEST` | 400 | JSON、必須field、header（`PolicySQL-Role`の複数指定など）が不正 |
| `POLICYSQL_JSON_TOO_DEEP` | 400 | request bodyのJSONの入れ子が上限（64 level）を超えた。単なるJSON構文エラーではなく原因を表す専用code。DB処理の前に拒否する。`Idempotency-Key`付きのAtomic Executeでは500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる（上限が65から64へ厳しくなり、ABI 16より前のdeployでcommit済みのwriteの再送かもしれないため。bodyは従来と同じ上限までしか読まず、lookup・実行・key消費も行わない）。unkeyedのAtomic Execute、keyが不正なrequest、begin、Explainはこのcodeのままで、clientは拒否（`PolicySqlRejectedError`）として扱う |
| `POLICYSQL_INVALID_SQL` | 400 | SQLをparseできない |
| `POLICYSQL_MULTIPLE_STATEMENTS` | 400 | statementが複数含まれる |
| `POLICYSQL_UNSUPPORTED_SQL` | 400 | 対応範囲外の構文 |
| `POLICYSQL_SQL_TOO_COMPLEX` | 400 | 入力は上限内だが、policyを合成して生成した文が下流の複雑さの上限（parserの式の高さ・再帰の深さ、結果列2,000、host parameter 32,766、LIKE/GLOBのpattern 50,000 bytes、envelopeのcolumn metadata 1 MiB、またはDBが複雑さを理由に拒否）に達した。pathは`/statements/<i>`で、messageは固定。COMMITより前に検知するため何もcommitされず、clientは拒否（`PolicySqlRejectedError`）として扱う。対話型transactionでは`failed`として閉じ、後続のcommandは409 `POLICYSQL_TRANSACTION_UNAVAILABLE`になる。`Idempotency-Key`付きのAtomic Executeでcompile時（emit時）に検出された場合は500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode。保存済み結果は返さず、何も実行しない）、unkeyedのAtomic Execute・Explain・DB実行時の拒否はこのcodeで、同じrequestを再送しても成功しない |
| `POLICYSQL_DUPLICATE_RESULT_COLUMN` | 400 | alias適用後のresult column名が重複した |
| `POLICYSQL_INVALID_PARAMETER` | 400 | parameterの不足、型、値が不正 |
| `POLICYSQL_AMBIGUOUS_PARAMETER_TYPE` | 400 | Explainでparameter型を一意に証明できない |
| `POLICYSQL_RESERVED_PARAMETER` | 400 | server用のparameter名を使用した |
| `POLICYSQL_IDEMPOTENCY_KEY_INVALID` | 400 | `Idempotency-Key`が空または書式不正（16〜128文字のASCII英数字と`. _ : - + / =`以外を含む、長さが範囲外、header重複によるカンマ結合）。keyの省略では発生しない。DB処理の前に拒否するため、再送しても成功しない |
| `POLICYSQL_FORBIDDEN_ACCESS` | 403 | `PolicySQL-Role`がtrusted sessionの`roles`にない、またはendpointに必要なaccessがない。`Idempotency-Key`付きのAtomic Executeでは500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる（deployでaccessまたはroleを失った主体による、commit済みwriteの再送かもしれないため。bodyは読まず、DB処理も行わない）。対話型transactionのcommitでは403のまま返り、これはADR 0007 #104の意図的な例外（session gateはownerより前に実行され、拒否されたsessionでownerのcommit記録を照会するとtransactionの存在やCOMMITの有無が漏れるため）。以前に送ったCOMMITが適用されなかったことを意味しない |
| `POLICYSQL_MISSING_POLICY` | 403 | 適用可能なpolicyがない。`Idempotency-Key`付きのAtomic Executeではcompile時に500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる。unkeyedのAtomic ExecuteとExplainではこのcode |
| `POLICYSQL_FORBIDDEN_OPERATION` | 403 | operationが許可されていない。`Idempotency-Key`付きのAtomic Executeではcompile時に500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる。unkeyedのAtomic ExecuteとExplainではこのcode |
| `POLICYSQL_FORBIDDEN_COLUMN` | 403 | 利用できないcolumnを参照した。`Idempotency-Key`付きのAtomic Executeではcompile時に500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる。unkeyedのAtomic ExecuteとExplainではこのcode |
| `POLICYSQL_FORBIDDEN_COLUMN_CONTEXT` | 403 | 条件付き出力列をprojection以外で参照した。`Idempotency-Key`付きのAtomic Executeではcompile時に500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる。unkeyedのAtomic ExecuteとExplainではこのcode |
| `POLICYSQL_PRESET_COLUMN` | 403 | clientがserver-owned columnを指定した。`Idempotency-Key`付きのAtomic Executeではcompile時に500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる。unkeyedのAtomic ExecuteとExplainではこのcode |
| `POLICYSQL_CHECK_FAILED` | 403 | 書き込んだ行がpolicyの`check`を満たさない（checkの結果がFALSEまたはUNKNOWN）。pathは`/statements/<i>`（失敗した文）、`detail`はなく、messageは固定でどのcheckかは返さない。COMMITより前に検知してrollbackするため何もcommitされず、確定的な拒否で、clientは拒否（`PolicySqlError`）として扱う。対話型transactionでは`failed`として閉じ、後続のcommandは409 `POLICYSQL_TRANSACTION_UNAVAILABLE`。`Idempotency-Key`付きでも同じで、今回の試行が何もcommitしておらずkeyにも何も記録していないことを意味する（以前の試行がcommitし、keyの記録が保持期間を過ぎて消えた後の再送は、deployでcheckが変わっていればこのcodeになり得る）。DBのCHECK制約の違反は409 `POLICYSQL_CONSTRAINT_VIOLATION`。データやrequestが変わらない限り、同じrequestを再送しても成功しない |
| `POLICYSQL_TRANSACTION_MODE_VIOLATION` | 403 | read transactionでmutationを実行しようとした |
| `POLICYSQL_DATABASE_BINDING_REJECTED` | 403 | DB bindingが不正、未登録、または現在の経路設定で許可されていない |
| `POLICYSQL_NOT_FOUND` | 404 | endpointが存在しない |
| `POLICYSQL_STALE_OPERATION` | 409 | policyまたはcatalog versionが古い |
| `POLICYSQL_IDEMPOTENCY_CONFLICT` | 409 | Atomic Execute（commit checkを行うDO経路を含む）で同じkeyが異なるrequest（payloadまたはDBのgenerationが違う）に使われた。deployでsnapshotが変わっただけの再送は衝突しない |
| `POLICYSQL_TRANSACTION_CONFLICT` | 409 | 対話型transactionのcommandが現在の状態（sequenceなど）と矛盾する |
| `POLICYSQL_TRANSACTION_UNAVAILABLE` | 409 | transactionが存在しない、利用者に属していない、期限切れ、または失敗状態。COMMITの送信前にbindingまたは期限の確認に失敗した場合も返します（COMMITは送られておらず、rollback済みです） |
| `POLICYSQL_COMMIT_CHECK_REJECTED` | 409 | commit checkがtransactionを拒否した、または安全に完了できない |
| `POLICYSQL_CONSTRAINT_VIOLATION` | 409 | 文の実行をDBが制約違反で拒否した（UNIQUE・PRIMARY KEY、NOT NULL、FOREIGN KEY、CHECK、triggerの`RAISE(ABORT)`など）。pathは`/statements/<i>`、`detail.constraint`は`unique`（PRIMARY KEYを含む）・`not_null`・`foreign_key`・`check`・`other`のどれか。messageは種類ごとの固定文。列名・制約名・DBの文言は返さない。COMMITより前に検知し、transactionは開いたままrollbackするため何もcommitされない。clientは拒否（`PolicySqlError`）として扱う。対話型transactionでは`failed`として閉じ、後続のcommandは409 `POLICYSQL_TRANSACTION_UNAVAILABLE`。`Idempotency-Key`付きでも同じで、今回の試行が何もcommitしていないことを意味する（以前の試行がcommitし、keyの記録が保持期間を過ぎて消えた後の再送は、自分が入れた行と重複してこのcodeになり得る）。schemaの`ON CONFLICT ROLLBACK`や`RAISE(ROLLBACK)`でDBがtransactionを閉じた場合は503 `POLICYSQL_DATABASE_UNAVAILABLE`（結果不明）、遅延FKでCOMMITが失敗した場合は結果不明のまま。データが変わらない限り、同じrequestを再送しても成功しない |
| `POLICYSQL_LIMIT_EXCEEDED` | 413 | requestまたはresult limitを超えた。行数、結果bytes、結果のJSON値の数、databaseの生の応答の上限、streaming transportが応答中にdecodeした結果のBLOB値の上限（buffering providerのBLOBはcoreがresult encodingで検出するため413のまま）、`maxStatements`、応答全体の`maxResponseBytes`を含む。commit前に判断し、envelopeはrollbackして冪等性recordも残さない。ただしatomic executeで2文目以降にwriteを含み、databaseの生の応答、またはstreaming transportが応答中にdecodeした結果のBLOB値が上限を超えた場合は、後続のwriteが実行された可能性があるため500 `POLICYSQL_INTERNAL`（結果不明）になる。その例外を除き、再送しても成功しない。さらに、`Idempotency-Key`付きのAtomic Executeでcompile時の入力上限（`maxStatements`、`maxParameters`、`maxExpressionDepth`、`maxProjections`、`maxJoins`、client parameterの`maxBytesPerValue`）に達した場合は500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になり、unkeyedのAtomic ExecuteとExplainは413のまま。malformed base64はkeyedのAtomic Executeではcompile errorとして500 `POLICYSQL_OUTCOME_UNKNOWN`（`detail.cause.code`は`POLICYSQL_INVALID_PARAMETER`など）、unkeyedのAtomic ExecuteとExplainでは400 |
| `POLICYSQL_REQUEST_TOO_LARGE` | 413 | HTTP body（`limits.maxRequestBytes`）、body内のJSON値の数（`limits.maxJsonValues`）、またはSQL text（`limits.maxSqlBytes`、pathは`/statements/<i>/sql`）が受付上限を超えた。HTTP bodyと`maxJsonValues`はcompileより前のbody checkで拒否する。ただし`Idempotency-Key`付きのAtomic Executeでは、deployで上限を引き下げた後にcommit済みwriteの再送が来る可能性があるため、500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明。`detail.cause.code`がこのcode）になる（unkeyed、またはkeyが不正なrequestは413）。`maxSqlBytes`はcompile時に検出するため、`Idempotency-Key`付きのAtomic Executeでは同じく500 `POLICYSQL_OUTCOME_UNKNOWN`（結果不明）、unkeyedのAtomic ExecuteとExplainでは413。unkeyedとkey不正の413、および`maxSqlBytes`のunkeyed 413は、再送しても成功しないためclientは拒否（`PolicySqlRejectedError`）として扱う。keyedの500 `POLICYSQL_OUTCOME_UNKNOWN`は結果不明（`PolicySqlOutcomeUnknownError`）で、rollbackとみなさず同じkey・同じbodyで再送する |
| `POLICYSQL_UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type`が`application/json`でない |
| `POLICYSQL_EXPECTATION_FAILED` | 422 | transaction operationの期待条件を満たさない |
| `POLICYSQL_SCHEMA_MISMATCH` | 422 | database値がcompiled logical contractと一致しない |
| `POLICYSQL_TRANSACTION_LIMIT_EXCEEDED` | 413 | 対話型transactionの恒久的な上限（statement数、累積result bytes）を超えた。commit checkのcallbackの行数・bytes・query数の上限でも発生し、その場合はvalidatorがこのcodeを受け取り、atomic executeや対話型commitは409 `POLICYSQL_COMMIT_CHECK_REJECTED`になる。再送しても成功しない。request rateの制限ではない |
| `POLICYSQL_INTERNAL` | 500 | 公開できない内部エラー。ラッパーが渡したtrusted sessionや文脈の形が不正な場合、またはatomic executeで2文目以降にwriteを含むenvelopeのdatabaseの生の応答、streaming transportが応答中にdecodeした結果のBLOB値が上限を超えた場合（結果不明）もこのcode。`Idempotency-Key`付きのAtomic Executeがcompile（`expected`の照合を含む）・session認可・入力上限のbody checkで通らない場合は、このcodeではなく500 `POLICYSQL_OUTCOME_UNKNOWN`になる |
| `POLICYSQL_OUTCOME_UNKNOWN` | 500 | `Idempotency-Key`付きのAtomic Executeが、DBを読む前のcompile、session認可、body checkの上限で通らなかった。何も実行せず、keyも消費しないが、同じkeyの以前のrequestがdeploy前のpolicy・schema・上限・sessionでcommit済みだったかもしれないため、結果不明として返す（保存済み結果は返さない）。`detail.cause`はkeyなしなら返っていたcodeとpath（`{ "code": "POLICYSQL_MISSING_POLICY", "path": "/statements/0" }`の形。codeは固定の列挙で、DBの状態に依存するcodeは含まない）。top-levelの`path`は常に`null`。rollbackとみなさず、同じkey・同じbodyで再送する。clientは結果不明（`PolicySqlOutcomeUnknownError`）として扱い、`error.cause.detail.cause`で原因を読める |
| `POLICYSQL_DATABASE_REQUIRED` | 500 | ラッパーが必須のDB引数を渡していない |
| `POLICYSQL_DATABASE_UNAVAILABLE` | 503 | database adapterまたはtransaction ownerを利用できない |
| `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` | 503 | commitを送った後に結果を確定できない（transaction ownerの喪失、ownerの記録の保存失敗、COMMIT中の通信エラー）。commit済みの可能性があるため、拒否ではなく結果不明として扱う |
| `POLICYSQL_TIMEOUT` | 504 | database実行がtimeoutした |
| `POLICYSQL_DATABASE_TIMEOUT` | 504 | DB接続準備・実行・commit確認の期限を超えた |

error codeはAPI versionごとの安定したcontractです。minor releaseで既存codeの意味やstatusを変更しません。以前この頁に載っていた`POLICYSQL_FORBIDDEN_ROLE`、`POLICYSQL_COMMIT_CHECK_UNAVAILABLE`、`POLICYSQL_COMMIT_CHECK_QUERY`、`POLICYSQL_COMMIT_CONFLICT`、`POLICYSQL_TRANSACTION_NOT_FOUND`、`POLICYSQL_TRANSACTION_EXPIRED`、`POLICYSQL_TRANSACTION_SEQUENCE`、`POLICYSQL_TRANSACTION_FAILED`、`POLICYSQL_REQUEST_IN_PROGRESS`は、どのコードも返したことがないため削除しました。役割の拒否は`POLICYSQL_FORBIDDEN_ACCESS`、transactionの不在・期限切れ・失敗は`POLICYSQL_TRANSACTION_UNAVAILABLE`、sequenceの不一致は`POLICYSQL_TRANSACTION_CONFLICT`です。`POLICYSQL_CHECK_FAILED`も以前の頁にありましたが返していませんでした。policyの`check`の失敗を表すcodeとして、意味を決め直して使っています。

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
| `POLICYSQL_UNAUTHENTICATED` | 401 | credentialがない、または無効・期限切れ・失効。ラッパーが返す401の標準code。参考ラッパーとJWT adapterはこのcodeだけを使う。対話型commitの再送でこの401になった場合、その拒否は以前のCOMMITが適用されなかったことを意味しない（ADR 0007 #104） |
| `POLICYSQL_AUTHENTICATION_FAILED` | 401 | 予約code。同梱のコードはどれも返さない。独自のラッパーが「credentialはあるが検証に失敗した」を、credentialがない場合と区別したいときに使える。clientは`POLICYSQL_UNAUTHENTICATED`と同じく「実行されていない」拒否として扱う。対話型commitでは同じ#104の例外であり、以前のCOMMITの結果を意味しない |
| `POLICYSQL_RATE_LIMITED` | 429 | request rate limitを超えた |

認証はライブラリの機能ではなく、ラッパーの責務です（[JWT認証](../security/jwt)）。ラッパーはcredentialを検証し、失敗した場合は`app.fetch`を呼ばずにHTTP 401を返します。標準codeは`POLICYSQL_UNAUTHENTICATED`です（参考実装はこれだけを返す）。`POLICYSQL_AUTHENTICATION_FAILED`は予約codeで、独自のラッパーが「credentialはあるが検証に失敗した」場合を区別したいときだけ使います。ライブラリは401を返しません。対話型transactionのcommandとcommitも毎回認証するため、token失効や期限切れの後はtransactionを継続できません。対話型commitの再送がこの401になる場合、その拒否は以前のCOMMITが適用されなかったことを意味しません（ADR 0007 #104）。accessまたはcredentialを復旧し（同じprincipal・subject・role・sessionの値のまま）、同じtransaction ID・sequence・payloadのcommitを再送すると、ownerに保存された結果を確認できます。sessionの値が変わったcredentialではownerは別の呼び出し元とみなすため、そのcommitは409 `POLICYSQL_TRANSACTION_UNAVAILABLE` になります。

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
- DBの制約名・表名・列名、triggerの文言

DBの制約違反は、種類（固定の列挙値）だけを返します。

運用者は`requestId`を使い、アクセス制限されたserver logで詳細を調査します。

## Retry

SQL・policy・parameter errorは、同じrequestを再送しても成功しません。requestを修正してください。timeout、rate limit、一時的なadapter error、commit conflictのretryは上限とbackoffを設けます。ライブラリはどのresponseにも`Retry-After`を付けません。ラッパーが429に`Retry-After`を付けた場合は、その秒数以上待ってから再送します。初回からkeyを指定したwriteの再送には、同じidempotency keyと同じpayloadを使用し、結果が確定する前に新しいkeyで再実行しません。keyなしのwriteは重複排除を保証しないため、結果不明時に自動再送すると二重更新になり得ます。`Idempotency-Key`付きのAtomic Executeが500 `POLICYSQL_OUTCOME_UNKNOWN`になった場合（`detail.cause`に今回の原因のcodeとpath）、それは結果不明です（deploy後のcompile・認可の失敗、または入力上限の引き下げ・深さ制限の厳格化を含みます）。500 `POLICYSQL_INTERNAL`でも、後続のwriteの応答が上限を超えた場合は結果不明です。rollbackされたとみなさず、同じkeyと同じpayloadで再送して結果を確定してください。対話型commitが403 `POLICYSQL_FORBIDDEN_ACCESS`または401になった場合も、その拒否は以前に送ったCOMMITの結果を確定しません（ADR 0007 #104）。rollbackされたとみなさず、アプリケーションのデータで確認してください。accessを復旧した後（同じprincipal・subject・role・sessionの値のまま）、同じtransaction ID・sequence・payloadのcommitを再送すると、ownerに保存された結果を確認できます。
