import test from "node:test";
import assert from "node:assert/strict";
import { authFingerprint, requestIdempotency, sha256, stableJson } from "../src/idempotency.ts";
import { authIdentity, callbackDigest, commandDigest, requestIdentity, startDigest } from "../src/identity.ts";
import { createInProcessPolicySql, loadRuntime } from "../../../examples/in-process/policysql.ts";
import { identityRuntime as runtime } from "./helpers/identity.mjs";

// ADR 0024 pull request 2: canonical JSON, SHA-256, and the identities move to core, and the
// engine uses core's result. These tests are the compatibility evidence: core and the
// TypeScript reference (`idempotency.ts`) compute byte-equal hashes over the ADR's corpus and
// over randomized JSON texts, and the gate fails a request closed when they ever differ.

const auth = {
  principal: "https://issuer.test:user_1", subject: "user_1", role: "member", roles: ["member"], access: ["execute"],
  session: { tenant_id: "tenant_a" },
};
const binding = { version: 1, scope: "tenant", databaseId: "db_1", generation: "1", snapshot: "snap_1" };
const KEY = "request-key-0001";

const core = (input) => JSON.parse(runtime.identity_json(typeof input === "string" ? input : JSON.stringify(input)));
// Core reads the value from the raw text (embedded, not re-serialized by JavaScript), so an
// escaped lone surrogate reaches its tokenizer as six ASCII characters.
const coreDigestOfText = (text) => core(`{"op":"callback","command":${text}}`).digest;
const referenceDigestOfText = (text) => sha256(stableJson(JSON.parse(text)));

const assertSameIdentities = async (text, label = text) => {
  assert.equal(coreDigestOfText(text), await referenceDigestOfText(text), `digest: ${label}`);
  const body = JSON.parse(text);
  for (const endpoint of ["execute", "interactive-start"]) {
    assert.deepEqual(
      core({ op: "request", endpoint, auth, binding, body: text, key: KEY }).idempotency,
      await requestIdempotency(KEY, auth, body, endpoint, binding),
      `request ${endpoint}: ${label}`,
    );
  }
  // The gate itself agrees (it throws on any mismatch).
  assert.deepEqual(
    await requestIdentity(runtime, { key: KEY, auth, bodyText: text, body, endpoint: "execute", databaseBinding: binding }),
    await requestIdempotency(KEY, auth, body, "execute", binding),
  );
  assert.equal(await commandDigest(runtime, "statement", body), await sha256(stableJson({ kind: "statement", command: body })), label);
  assert.equal(await callbackDigest(runtime, body), await sha256(stableJson(body)), label);
  const transactionId = `tx_${"0".repeat(32)}`;
  assert.equal(await startDigest(runtime, transactionId, text, body),
    await sha256(stableJson({ transactionId, request: body })), label);
};

// Every corpus case alone, as an object member value, nested, and as an array element; string
// cases also as object keys, numbers also as the key spelled by their text.
const forms = (text) => {
  const value = JSON.parse(text);
  return [
    text,
    `{"k":${text}}`,
    `{"a":[{"b":{"c":${text}}}],"z":${text}}`,
    `[${text},1,${text}]`,
    ...(typeof value === "string" ? [`{${text}:1,"z":2,"è":3,"\\ud83d\\ude01":4,"":5}`] : []),
    ...(typeof value === "number" ? [`{${JSON.stringify(text)}:${text}}`] : []),
  ];
};

// The ADR 0024 corpus with what `stableJson` prints for each value (asserted against the
// reference, so the expectations document today's bytes).
const CORPUS = [
  ["9007199254740993", "9007199254740992"],
  ["-9007199254740993", "-9007199254740992"],
  ["18446744073709551616", "18446744073709552000"],
  ["-0", "0"],
  ["-0.0", "0"],
  ["1e400", "null"],
  ["-1e400", "null"],
  ["1e-400", "0"],
  ["1.0", "1"],
  ["1E5", "100000"],
  ["1e21", "1e+21"],
  ["1e20", "100000000000000000000"],
  ["1e-7", "1e-7"],
  ["1e-6", "0.000001"],
  ["0.1", "0.1"],
  ["5e-324", "5e-324"],
  ["1.7976931348623157e308", "1.7976931348623157e+308"],
  ["123.456e-2", "1.23456"],
  // Two shortest candidates equally close to the double: the even one (Rust's own shortest
  // rendering would take the upper one).
  ["93794707416597.1317", "93794707416597.12"],
  ["70368744177664.125", "70368744177664.12"],
  ["70368744177664.375", "70368744177664.38"],
  ["1e23", "1e+23"],
  [String.raw`"\u0000\u0001\u001f\u007f"`, String.raw`"\u0000\u0001\u001f` + "\u007f\""],
  [String.raw`"\b\f\n\r\t"`, String.raw`"\b\f\n\r\t"`],
  [String.raw`"  "`, "\"  \""],
  ["\" \"", "\" \""],
  [String.raw`"\/"`, "\"/\""],
  [String.raw`"\""`, String.raw`"\""`],
  [String.raw`"\\"`, String.raw`"\\"`],
  [String.raw`"\ud800"`, String.raw`"\ud800"`],
  [String.raw`"\uDBFF"`, String.raw`"\udbff"`],
  [String.raw`"\udc00"`, String.raw`"\udc00"`],
  [String.raw`"\ud800\ud800x\udc00"`, String.raw`"\ud800\ud800x\udc00"`],
  [String.raw`"\udc00\ud800"`, String.raw`"\udc00\ud800"`],
  [String.raw`"😀"`, "\"\u{1f600}\""],
  ["\"\u{1f600}\u{e000}\u{ffff}é\"", "\"\u{1f600}\u{e000}\u{ffff}é\""],
  [String.raw`"A"`, "\"A\""],
  ["\"\"", "\"\""],
  // Astral keys sort by UTF-16 code units: U+1F600 (D83D DE00) before U+E000 and U+FFFF.
  ["{\"\u{ffff}\":1,\"\u{1f600}\":2,\"\u{e000}\":3,\"a\":4,\"\":5,\"aa\":6,\"B\":7}",
    "{\"\":5,\"B\":7,\"a\":4,\"aa\":6,\"\u{1f600}\":2,\"\u{e000}\":3,\"\u{ffff}\":1}"],
  [String.raw`{"\ud800":1,"\udc00":2,"":3}`, String.raw`{"\ud800":1,"\udc00":2,` + "\"\u{e000}\":3}"],
  ["null", "null"],
  ["true", "true"],
  ["false", "false"],
  ["{}", "{}"],
  ["[]", "[]"],
  [" { \"b\" : [ 1 , { \"d\" : null , \"c\" : \"x\" } ] , \"a\" : { } } ", "{\"a\":{},\"b\":[1,{\"c\":\"x\",\"d\":null}]}"],
  // Deep nesting, near the engine's body bound of 65 levels.
  [`${"[".repeat(64)}1${"]".repeat(64)}`, `${"[".repeat(64)}1${"]".repeat(64)}`],
  [`${"{\"a\":".repeat(64)}1${"}".repeat(64)}`, `${"{\"a\":".repeat(64)}1${"}".repeat(64)}`],
];

test("the ADR 0024 corpus prints as documented and hashes identically in core and the reference", async () => {
  for (const [text, printed] of CORPUS) {
    assert.equal(stableJson(JSON.parse(text)), printed, `reference bytes: ${text}`);
    for (const form of forms(text)) await assertSameIdentities(form);
  }
});

test("auth fingerprints and keys match the reference, and key syntax errors agree", async () => {
  const sessions = [{}, { tenant_id: "tenant_a" }, { b: "2", a: "1", "\u{1f600}": "x", "\u{e000}": "y" }, { tenant_id: " /\"" }];
  for (const session of sessions) {
    const value = { ...auth, session };
    assert.equal(core({ op: "auth", auth: value, binding }).fingerprint, await authFingerprint(value, binding));
    assert.equal(await authIdentity(runtime, value, binding), await authFingerprint(value, binding));
  }
  for (const key of ["a".repeat(16), "A.b_c:d-0123456789", "z".repeat(128)]) {
    assert.deepEqual(
      await requestIdentity(runtime, { key, auth, bodyText: "{}", body: {}, endpoint: "execute", databaseBinding: binding }),
      await requestIdempotency(key, auth, {}, "execute", binding),
    );
  }
  assert.equal(await requestIdentity(runtime, { key: undefined, auth, bodyText: "{}", body: {}, endpoint: "execute", databaseBinding: binding }), null);
  for (const key of [null, 1, "", "a".repeat(15), "a".repeat(129), `${KEY},${KEY}`, `${KEY}\n`, "request key 00001", "request-key-00é1"]) {
    await assert.rejects(requestIdempotency(key, auth, {}, "execute", binding), { code: "POLICYSQL_IDEMPOTENCY_KEY_REQUIRED" });
    await assert.rejects(
      requestIdentity(runtime, { key, auth, bodyText: "{}", body: {}, endpoint: "execute", databaseBinding: binding }),
      { code: "POLICYSQL_IDEMPOTENCY_KEY_REQUIRED", message: /^Idempotency-Key must contain 16-128 letters/ },
      JSON.stringify(key),
    );
  }
});

test("negative case: an undefined identity field is hashed by the reference but rejected by core", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(JSON.parse(line)));
  // `stableJson` prints `undefined` for an absent value; that string is not JSON.
  assert.equal(stableJson({ principal: undefined }), "{\"principal\":undefined}");
  const missing = { ...auth, principal: undefined };
  assert.match(await requestIdempotency(KEY, missing, {}, "execute", binding).then((value) => value.keyHash), /^[a-f0-9]{64}$/u);
  // Core requires every identity field that reaches a hash to be a string.
  for (const field of ["principal", "subject", "role"]) {
    for (const bad of [undefined, null, 1, ["x"]]) {
      const value = { ...auth, [field]: bad };
      assert.equal(core({ op: "auth", auth: value, binding }).error.code, "POLICYSQL_INTERNAL", `${field}=${bad}`);
      assert.equal(core({ op: "request", endpoint: "execute", auth: value, binding, body: "{}", key: KEY }).error.code, "POLICYSQL_INTERNAL");
    }
  }
  assert.equal(core({ op: "auth", auth: { ...auth, session: { tenant_id: undefined, other: "x" } }, binding }).fingerprint,
    core({ op: "auth", auth: { ...auth, session: { other: "x" } }, binding }).fingerprint,
    "JSON.stringify drops the undefined member before core sees it");
  assert.equal(core({ op: "auth", auth: { ...auth, session: { tenant_id: 1 } }, binding }).error.code, "POLICYSQL_INTERNAL");
  // Through the gate the disagreement is a 500, never a hash.
  await assert.rejects(
    requestIdentity(runtime, { key: KEY, auth: missing, bodyText: "{}", body: {}, endpoint: "execute", databaseBinding: binding }),
    { code: "POLICYSQL_INTERNAL" },
  );
  await assert.rejects(authIdentity(runtime, missing, binding), { code: "POLICYSQL_INTERNAL" });
  assert.deepEqual(logs, [
    { event: "identity_mismatch", computation: "request", requestId: null, core: "error", reference: "value" },
    { event: "identity_mismatch", computation: "auth", requestId: null, core: "error", reference: "value" },
  ]);
});

// A small seeded generator of JSON texts. Every spelling the grammar allows is drawn:
// whitespace, number forms (long integers, fractions, exponents in either case and sign,
// overflow and underflow, shortest and long renderings of random doubles), every string
// escape, `\u` escapes of any code unit in either case (lone surrogates included), and raw BMP
// and astral characters.
const generator = (seed) => {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (n) => Math.floor(random() * n);
  const pick = (items) => items[int(items.length)];
  const space = () => (random() < 0.15 ? pick([" ", "\n", "\t", "\r", " \r\n "]) : "");
  const digits = (min, max) => Array.from({ length: min + int(max - min + 1) }, () => String(int(10))).join("");
  const integer = () => (random() < 0.2 ? "0" : `${1 + int(9)}${digits(0, 24)}`);
  const randomDouble = () => {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(0, int(2 ** 32));
    view.setUint32(4, int(2 ** 32));
    const value = view.getFloat64(0);
    if (!Number.isFinite(value)) return "1";
    return pick([String(value), value.toExponential(int(21)), value.toPrecision(1 + int(21))]).replace(/^-?/, "");
  };
  const number = () => {
    const sign = random() < 0.3 ? "-" : "";
    switch (int(7)) {
      case 0: return `${sign}${integer()}`;
      // A binary fraction of large magnitude: a short exact expansion, so two shortest
      // candidates can tie (ECMAScript takes the even one).
      case 5: {
        const value = (int(2 ** 26) * 2 ** 27 + int(2 ** 27)) / 2 ** int(40);
        return `${sign}${pick([value.toFixed(int(8)), value.toExponential(int(18)), String(value)])}`;
      }
      case 1: return `${sign}${integer()}.${digits(1, 20)}`;
      case 2: return `${sign}${integer()}${random() < 0.5 ? `.${digits(1, 8)}` : ""}${pick(["e", "E"])}${pick(["", "+", "-"])}${digits(1, 3)}`;
      case 3: return `${sign}${randomDouble()}`.replace(/e\+/u, pick(["e", "E+", "e+", "E"])).replace(/e-/u, pick(["e-", "E-"]));
      case 4: return `${sign}${pick(["0", "0.0", "5e-324", "1e21", "1e-7", "9007199254740993", "1e400", "2.2250738585072014e-308", "1.7976931348623157e308", "1.7976931348623159e308", "4.9e-324", "0.1", "1e-6", "123456789012345678901"])}`;
      default: return `${sign}${int(1000)}`;
    }
  };
  const hex4 = (unit) => {
    const text = unit.toString(16).padStart(4, "0");
    return random() < 0.5 ? text : text.toUpperCase();
  };
  const rawCharacter = () => {
    const ranges = [[0x20, 0x7e], [0x80, 0x7ff], [0x800, 0xd7ff], [0xe000, 0xffff], [0x10000, 0x10ffff]];
    for (;;) {
      const [low, high] = pick(ranges);
      const point = low + int(high - low + 1);
      const character = String.fromCodePoint(point);
      if (character !== "\"" && character !== "\\") return character;
    }
  };
  const stringPiece = () => {
    switch (int(7)) {
      case 0: return pick(["\\\"", "\\\\", "\\/", "\\b", "\\f", "\\n", "\\r", "\\t"]);
      case 1: return `\\u${hex4(int(0x10000))}`;
      case 2: return `\\u${hex4(0xd800 + int(0x800))}`;
      case 3: return `\\u${hex4(0xd800 + int(0x400))}\\u${hex4(0xdc00 + int(0x400))}`;
      case 4: return pick([" ", " ", "\u{1f600}", "\u{e000}", "\u{ffff}", "é"]);
      default: return rawCharacter();
    }
  };
  const string = () => `"${Array.from({ length: int(6) }, stringPiece).join("")}"`;
  const value = (depth) => {
    const kind = depth > 5 ? 2 + int(5) : int(7);
    switch (kind) {
      case 0: {
        const keys = new Set();
        const members = [];
        for (let i = int(6); i > 0; i--) {
          const key = string();
          const decoded = JSON.parse(key);
          if (keys.has(decoded)) continue;
          keys.add(decoded);
          members.push(`${space()}${key}${space()}:${space()}${value(depth + 1)}${space()}`);
        }
        return `{${members.join(",") || space()}}`;
      }
      case 1: return `[${Array.from({ length: int(5) }, () => `${space()}${value(depth + 1)}${space()}`).join(",") || space()}]`;
      case 2: case 3: return string();
      case 4: return number();
      default: return pick(["true", "false", "null"]);
    }
  };
  return () => `${space()}${value(0)}${space()}`;
};

test("randomized differential: core and the reference agree on generated JSON texts", async () => {
  const seed = Number(process.env.POLICYSQL_IDENTITY_SEED ?? 0x35_0002);
  const count = Number(process.env.POLICYSQL_IDENTITY_CASES ?? 3_000);
  const next = generator(seed);
  for (let index = 0; index < count; index++) {
    const text = next();
    const label = `seed ${seed} case ${index}: ${JSON.stringify(text)}`;
    assert.equal(coreDigestOfText(text), await referenceDigestOfText(text), label);
    if (index % 10 === 0) await assertSameIdentities(text, label);
  }
});

test("the gate fails closed: a core result that differs from the reference is a 500 before any database work", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (line) => logs.push(JSON.parse(line)));
  const getRuntime = loadRuntime();
  const real = getRuntime();
  let corrupt = null;
  // The real runtime, except that identity_json returns a wrong hash for one operation.
  const runtimeProxy = new Proxy(real, {
    get(target, key) {
      if (key === "identity_json") {
        return (input) => {
          const output = target.identity_json(input);
          return JSON.parse(input).op === corrupt ? output.replace(/[a-f0-9]{64}/u, "0".repeat(64)) : output;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const p = createInProcessPolicySql(() => runtimeProxy);
  t.after(() => p.close());
  const session = {
    principal: "in-process:tenant_a", subject: "user_a", roles: ["member"], defaultRole: "member",
    access: ["execute"], session: { tenant_id: "tenant_a" },
  };
  const context = (requestId) => ({ database: p.binding, session, requestId });
  const insert = (id) => JSON.stringify({ statements: [{ sql: "INSERT INTO projects (id, name) VALUES (:id, :name)", params: { id, name: "x" } }] });
  const rows = () => p.database.prepare("SELECT count(*) AS n FROM projects").get().n;
  const mismatches = () => logs.filter((entry) => entry.event === "identity_mismatch");

  corrupt = "request";
  const before = rows();
  const executed = await p.engine.execute({ bodyText: insert("p1"), idempotencyKey: KEY }, context("req_gate_execute"));
  assert.equal(executed.ok, false);
  assert.equal(executed.error.code, "POLICYSQL_INTERNAL");
  assert.equal(rows(), before, "nothing executed");
  const begun = await p.engine.begin({ bodyText: "{\"mode\":\"write\"}", idempotencyKey: KEY }, context("req_gate_begin"));
  assert.equal(begun.error.code, "POLICYSQL_INTERNAL");

  corrupt = "start";
  assert.equal((await p.engine.begin({ bodyText: "{\"mode\":\"write\"}" }, context("req_gate_start"))).error.code, "POLICYSQL_INTERNAL");

  corrupt = null;
  const transaction = await p.engine.begin({ bodyText: "{\"mode\":\"write\"}" }, context("req_begin"));
  assert.equal(transaction.ok, true, JSON.stringify(transaction));
  const { transactionId } = transaction.value;
  const statement = (sequence, id) => p.engine.statement({
    transactionId, bodyText: JSON.stringify({ sequence, sql: "INSERT INTO projects (id, name) VALUES (:id, :name)", params: { id, name: "x" } }),
  }, context(`req_statement_${sequence}`));

  corrupt = "auth";
  assert.equal((await statement(1, "p2")).error.code, "POLICYSQL_INTERNAL");
  // The owner computes the command digest through the same gate.
  corrupt = "command";
  assert.equal((await statement(1, "p2")).error.code, "POLICYSQL_INTERNAL");

  assert.deepEqual(mismatches(), [
    { event: "identity_mismatch", computation: "request", requestId: "req_gate_execute", core: "value", reference: "value" },
    { event: "identity_mismatch", computation: "request", requestId: "req_gate_begin", core: "value", reference: "value" },
    { event: "identity_mismatch", computation: "start", requestId: "req_gate_start", core: "value", reference: "value" },
    { event: "identity_mismatch", computation: "auth", requestId: "req_statement_1", core: "value", reference: "value" },
    { event: "identity_mismatch", computation: "command", requestId: "req_statement_1", core: "value", reference: "value" },
  ]);
  for (const entry of mismatches()) {
    assert.ok(!JSON.stringify(entry).includes(KEY) && !JSON.stringify(entry).includes("tenant_a"), "no values are logged");
  }

  // With agreement the transaction proceeds as before, and the statement was not run twice.
  corrupt = null;
  const retried = await statement(1, "p2");
  assert.equal(retried.ok, true, JSON.stringify(retried));
  // The commit's digest (compared with `commitSent` on a retry, #48) goes through the gate too.
  corrupt = "command";
  const gated = await p.engine.commit({ transactionId, bodyText: JSON.stringify({ sequence: 2 }) }, context("req_commit_gate"));
  assert.equal(gated.error.code, "POLICYSQL_INTERNAL");
  corrupt = null;
  const committed = await p.engine.commit({ transactionId, bodyText: JSON.stringify({ sequence: 2 }) }, context("req_commit"));
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(rows(), before + 1);
  assert.deepEqual(mismatches().slice(5), [
    { event: "identity_mismatch", computation: "command", requestId: "req_commit_gate", core: "value", reference: "value" },
  ], "one more for the gated commit, none when core and the reference agree");
});
