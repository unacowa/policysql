---
title: HTTPを使わない入口
description: engineの操作を直接呼ぶ方法と、HTTP adapterとの関係です。
---

# HTTPを使わない入口

PolicySQLのengineはHTTPではなく操作を公開します（[ADR 0023](https://github.com/unacowa/policysql/blob/main/docs/adr/0023-operations-api-and-http-adapter.md)）。HTTPは操作を呼ぶ入力側adapterの1つです。同じprocess内の呼び出しやCloudflareのservice bindingからは、操作を直接呼べます。

## 操作

| 操作 | 入力 | HTTPでの対応 |
| --- | --- | --- |
| `execute` | `{ bodyText, idempotencyKey?, role? }` | `POST /v1/transactions:execute` |
| `explain` | `{ bodyText, role? }` | `POST /v1/transactions:explain` |
| `begin` | `{ bodyText, idempotencyKey?, role? }` | `POST /v1/transactions`（成功は201） |
| `statement` / `commit` / `rollback` | `{ transactionId, bodyText, role? }` | `POST /v1/transactions/{id}/statements` など |
| `catalog` / `capabilities` | `{ role?, ifNoneMatch? }` | `GET /v1/catalog`、`GET /v1/capabilities` |
| `callbackQuery` | `{ validationId, capability, bodyText }` | `POST /v1/commit-checks/{id}/query` |
| `health` | なし | `GET /healthz` |

clientの操作は、文脈、session、DB binding、本文の順に確認します。sessionやDBを拒否したrequestの本文は読みません。clientの操作は2つ目の引数に`{ database, session, requestId? }`を取ります。`database`と`session`はラッパーが決めた値です（[ラッパーからDBを渡す](./database-routing)）。`callbackQuery`と`health`は`{ requestId? }`だけを取ります。`execute`は3つ目の引数に`BackgroundTasks`を取れます。

`role`は`PolicySQL-Role`、`idempotencyKey`は`Idempotency-Key`、`ifNoneMatch`は手元にあるrepresentationのsnapshot（HTTPでは`ETag`の中身）、`capability`はvalidatorが受け取ったopaque token（HTTPでは`Authorization: Bearer`の後ろ）です。

## 結果

結果はHTTP statusを含みません。

```ts
{ ok: true, value, requestId }
{ ok: false, error: { code, message, path }, requestId }
// catalog / capabilities
{ ok: true, notModified: false, snapshot, value, requestId }
{ ok: true, notModified: true, snapshot, requestId }
```

`code`は[エラー](../api/errors)のcodeと同じです。操作は例外を投げません。

## 本文

`bodyText`は本文の文字列か、文字列を返す関数です。関数を渡すと、engineはsessionとDBを確認した後、本文が必要になった時点で呼びます。engineはどの入口でも同じ検査をします。不正なUnicode（対になっていないsurrogate。生の文字でも、JSON文字列内の`\ud800`のようなエスケープでも同じエラー）、UTF-8で1 MiBを超える本文（先頭のBOMも3 byteとして数える）、重複したJSON key、不正なJSONを拒否します。先頭のBOM（U+FEFF）は1つだけ取り除きます。bytesからの復号は入口の役割です。HTTP adapterは不正なUTF-8を置換せずに拒否します。

## 組み立て

```ts
import { createApp, createEngine, createHttpAdapter } from "@unacowa/policysql/cloudflare";

const engine = createEngine({ getRuntime, database, config, transactionOwners });
const result = await engine.execute(
  { bodyText: JSON.stringify({ statements: [{ sql: "SELECT id FROM projects", params: {} }] }) },
  { database: binding, session },
);

// HTTP: 同じengineにHTTP adapterを付ける
const http = createHttpAdapter(engine); // createApp(...) は engine と HTTP adapter の組
```

Workersでは`createPolicySqlWorker(...).engine(env)`が、`worker.app`と同じengineを返します。

動く例は`examples/in-process/`です。Node.jsの1 processで、`node:sqlite`をDBにしてすべての操作を呼びます。

## 独自のHTTP対応づけ

HTTPで公開するラッパーは、同梱のHTTP adapter（`createApp`、`createHttpAdapter`、`createPolicySqlWorker`）を使うか、独自の対応づけで適合テストを通します。

```ts
import { runHttpConformance } from "@unacowa/policysql/cloudflare/http-conformance";

const results = await runHttpConformance((engine) => myHttpMapping(engine));
const failures = results.filter((result) => !result.ok);
```

適合テストは記録用のengineの上で対応づけだけを確認します。route、header、本文の枠（`Content-Type`、`Content-Length`、streamでの上限、UTF-8）、全codeのstatus、固定header、ETagと304、request ID、ラッパーの文脈の誤りを確認し、DBやtest frameworkは不要です。
