import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard (#34, ADR 0027): no byte or count limit may exist as a private constant in
// `src/`. A request limit is a `RuntimeLimits` field the runtime reports (src/limits.ts), a
// fixed protocol constant listed here with its reason, or a bound computed by core.
//
// The layer boundaries of ADR 0019/0021/0022 that this file used to scan for (HTTP in the
// engine, Durable Object names, the environment object) are lint rules now (issue #59,
// eslint.config.js) and the engine's HTTP types are a compile error under tsconfig.engine.json;
// test/boundary.test.mjs holds their probes.
const root = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".ts")).map((name) => name.split("\\").join("/"));

// ADR 0027 ("No other byte constant may exist on the request path"): a request limit is a
// RuntimeLimits field the runtime reports (src/limits.ts), a fixed protocol constant listed
// here with its reason, or a bound computed by core. A numeric expression of 1,000 or more in
// `src/` that is not listed fails the test, so a new byte (or count) limit cannot appear as a
// private constant in the engine or an adapter. Literals are read with comments and string
// contents removed. Forms read: decimal with `_` and exponent (`1e6`), hex, octal, binary, and
// chains joined by `*`, `**`, `<<`, `+`, `-` (`1024 * 1024`, `1 << 20`, `2 ** 16`).
//
// Each entry is keyed by the identifier next to the expression ("context": the last word before
// it, `CONTROL_RESPONSE_BYTES`, `timeoutMs`, `min`) and its value, with how many times it occurs,
// so a second 65_536 under another name, or a third use under the same one, fails.
const FIXED_LITERALS = new Map([
  ["turso-http.ts", new Map([
    ["CONTROL_RESPONSE_BYTES:65536", [1, "the database control reply bound (BEGIN, COMMIT, ROLLBACK, close): a fixed protocol constant"]],
    ["timeoutMs:1000", [1, "default request timeout, in milliseconds (a time, not a size)"]],
    ["INT64_MIN:9223372036854776000", [1, "the signed 64-bit integer range of Hrana (2n ** 63n), not a limit"]],
    ["INT64_MAX:9223372036854776000", [1, "the signed 64-bit integer range of Hrana (2n ** 63n - 1n), not a limit"]],
  ])],
  ["bounded-body.ts", new Map([
    ["PREFIX_BYTES:1024", [1, "the leading bytes of a refused reply kept to read its Hrana baton (#96): not a limit on data"]],
  ])],
  ["adapters/commit-check-hook.ts", new Map([
    ["VALIDATOR_RESPONSE_BYTES:65536", [1, "the validator reply bound: a fixed protocol constant"]],
    ["now:1000", [1, "milliseconds per second, for the signature timestamp"]],
  ])],
  // The detail table (#145 pull request C): the ceiling of a statement's byte length.
  ["error-detail.ts", new Map([
    ["MAX_SPAN_OFFSET:1048576", [1, "`MAX_SQL_BYTES_CEILING`: the largest offset a `span` may name, a fixed protocol constant of the table, kept equal to core's by test"]],
  ])],
  ["database.ts", new Map([
    ["BUFFERED_RESULT_BYTES:64000", [1, "the reference wrapper's maxResultBytes: above it a provider that buffers replies is logged once (a notice threshold, not a limit)"]],
    ["now:1000", [1, "the provider timeout, in milliseconds (a time, not a size)"]],
    ["remaining:1000", [1, "the same timeout, compared with the time left"]],
    ["min:1000", [1, "the same timeout, as an upper bound for the timer"]],
  ])],
  ["adapters/jwt.ts", new Map([
    ["timeoutDuration:1500", [1, "JWKS timeout, in milliseconds"]],
    ["cooldownDuration:30000", [1, "JWKS cooldown, in milliseconds"]],
    ["cacheMaxAge:300000", [1, "JWKS cache age, in milliseconds"]],
  ])],
  // The cleanup (ADR 0028) is off the request path and its numbers are retention and batching,
  // not request limits: the window is the reference wrapper's default, which the caller may
  // override. The batch size (500) and batch cap (128) are under this scan's threshold.
  ["idempotency-cleanup.ts", new Map([
    ["IDEMPOTENCY_RETENTION_DAYS:86400", [1, "30 days in seconds: the reference wrapper's default retention window (an age, not a request limit)"]],
  ])],
  // The recording engine of the conformance suite is a test double with a limit of its own.
  ["http/conformance.ts", new Map([
    ["maxRequestBytes:4096", [1, "the double's request limit"]],
  ])],
]);

const stripped = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/gu, "$1")
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, '""');
const NUMBER = String.raw`(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?`;
const CHAIN = new RegExp(String.raw`(?<![\w.$])(${NUMBER}(?:\s*(?:\*\*|<<|\*|\+|-)\s*${NUMBER})*)(?![\w.$])`, "gu");
const valueOf = (expression) => {
  // The expression holds only numbers and the operators above, so evaluating it is safe.
  const cleaned = expression.replaceAll("_", "").replace(/(\d)n\b/gu, "$1");
  return Number(Function(`"use strict"; return (${cleaned});`)());
};
/** The numeric expressions of 1,000 or more, as `context:value` (context: the last word before it). */
const largeLiterals = (text) => {
  const code = stripped(text);
  return [...code.matchAll(CHAIN)].flatMap((match) => {
    const value = valueOf(match[1]);
    if (!(value >= 1_000)) return [];
    const before = code.slice(0, match.index).match(/([A-Za-z_$][\w$]*)[\s:=<>!+\-*/,()\]]*$/u);
    return [`${before?.[1] ?? ""}:${value}`];
  });
};
const tally = (items) => items.reduce((counts, item) => counts.set(item, (counts.get(item) ?? 0) + 1), new Map());

test("no byte or count limit literal is left in src/ outside the fixed protocol constants", () => {
  for (const name of files) {
    const allowed = FIXED_LITERALS.get(name) ?? new Map();
    const found = tally(largeLiterals(readFileSync(join(root, name), "utf8")));
    const unlisted = [...found].filter(([key, count]) => (allowed.get(key)?.[0] ?? 0) !== count).map(([key, count]) => `${key} x${count}`);
    assert.deepEqual(unlisted, [], `${name}: a limit is a RuntimeLimits field, a fixed protocol constant listed here, or computed by core (ADR 0027)`);
  }
  // Every listed constant is still present, as often as listed: the list cannot go stale.
  for (const [name, allowed] of FIXED_LITERALS) {
    const found = tally(largeLiterals(readFileSync(join(root, name), "utf8")));
    for (const [key, [count]] of allowed) assert.equal(found.get(key) ?? 0, count, `${name}: ${key}`);
  }
});

test("the literal scan catches every numeric form of a limit and ignores comments, strings, and small numbers", () => {
  for (const text of [
    "const MAX = 1_048_576;", "if (n > 65536) {}", "const limit = 2097152", "x.length > 262_144", "const b = 1024 * 1024;",
    "const h = 0x10000;", "const h = 0XFFFF_FFFF;", "const e = 1e6;", "const e = 2.5e3;", "const s = 1 << 20;", "const p = 2 ** 16;",
    "const q = 256 * 256;", "const r = 64 * 1_024;", "const o = 0o200000;", "const b2 = 0b10000000000;", "const big = 1048576n;",
    "const sum = 1000 + 24;",
  ]) {
    assert.ok(largeLiterals(text).length > 0, text);
  }
  assert.deepEqual(largeLiterals("const MAX_BODY = 1 << 20;"), ["MAX_BODY:1048576"]);
  assert.deepEqual(largeLiterals("const CAP = 256 * 256;"), ["CAP:65536"]);
  assert.deepEqual(largeLiterals("const CAP = 0x10000;"), ["CAP:65536"]);
  for (const text of [
    "// 1_048_576 in a comment", "/* 65536 */ const a = 1;", 'const message = "limit 65_536";', "const depth = 64; const id = 128;",
    "v1.2.3000", "const mask = 0xff; const k = 1 << 4; const t = 16 * 16;", "const e = 5e2;", "const x = a.b3000;",
  ]) {
    assert.deepEqual(largeLiterals(text), [], text);
  }
  // A second use of an allowed value under another name, or twice under one name, is not allowed.
  const allowed = FIXED_LITERALS.get("turso-http.ts");
  const second = tally(largeLiterals("const CONTROL_RESPONSE_BYTES = 65_536; const OTHER = 65_536;"));
  assert.equal(allowed.has("OTHER:65536"), false);
  assert.equal(second.get("OTHER:65536"), 1);
  assert.equal(tally(largeLiterals("const CONTROL_RESPONSE_BYTES = 65_536; const CONTROL_RESPONSE_BYTES = 0x10000;")).get("CONTROL_RESPONSE_BYTES:65536"), 2);
});
