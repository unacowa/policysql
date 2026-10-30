import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { identityRuntime as runtime } from "./helpers/identity.mjs";

// ADR 0025: core's canonical JSON is the only definition, and it need not equal any
// TypeScript function. These tests pin it through the WASM the engine and the owner load: a
// callback digest is `sha256(canonical(command))`, so each case states the canonical text.
// Duplicate keys are rejected, and the form is deterministic across spellings of one value.

const core = (input) => JSON.parse(runtime.identity_json(input));
const digestOfText = (text) => core(`{"op":"callback","command":${text}}`);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const assertCanonical = (text, canonical) =>
  assert.deepEqual(digestOfText(text), { digest: sha256(canonical) }, `${text} -> ${canonical}`);
const assertRejected = (text) => assert.equal(digestOfText(text).error?.code, "POLICYSQL_INTERNAL", text);

test("(b) integers within 2^53 - 1 print as digits whatever their spelling; other numbers by core's fixed rule", () => {
  for (const [text, canonical] of [
    ["1", "1"], ["1.0", "1"], ["1e0", "1"], ["10E-1", "1"], ["100e-2", "1"], ["-0", "0"], ["-0.0", "0"], ["0e5", "0"],
    ["1E5", "100000"], ["-12.5e3", "-12500"], ["9007199254740991", "9007199254740991"],
    ["9007199254740991.0", "9007199254740991"], ["-9007199254740991", "-9007199254740991"], ["1e-400", "0"],
    // Not integers within 2^53 - 1: the shortest round-tripping text, or a 64-bit integer lexeme's digits.
    ["0.1", "0.1"], ["1.5", "1.5"], ["-37.40", "-37.4"], ["1e21", "1e+21"], ["1e-7", "1e-7"], ["5e-324", "5e-324"],
    ["9007199254740992.0", "9007199254740992.0"], ["9007199254740993", "9007199254740993"],
    ["18446744073709551616", "1.8446744073709552e+19"],
  ]) assertCanonical(text, canonical);
  // Outside the double range: rejected, as compile rejects it.
  for (const text of ["1e400", "-1e400", "[1e309]"]) assertRejected(text);
});

test("(c) strings use JSON.stringify's escapes and raw UTF-8 for everything else", () => {
  assertCanonical(String.raw`"\u0000\u0001\u001f\b\f\n\r\t\"\\\/"`, String.raw`"\u0000\u0001\u001f\b\f\n\r\t\"\\/"`);
  assertCanonical(String.raw`"\u000B\u001A"`, String.raw`"\u000b\u001a"`);
  assertCanonical(String.raw`"\u007f\u2028\u2029\u00e9\u5c71\ud83d\ude00"`, "\"\u007f\u2028\u2029é山\u{1f600}\"");
  assertCanonical("\"\u007f\u2028é山\u{1f600}\"", "\"\u007f\u2028é山\u{1f600}\"");
  // Escaped lone surrogates never reach hashing: core fails closed (the engine rejects them first).
  for (const text of [String.raw`"\ud800"`, String.raw`"\udc00"`, String.raw`{"\ud800":1}`, String.raw`"\udc00\ud800"`]) assertRejected(text);
});

test("(d) object keys are ordered by their UTF-8 bytes, arrays keep their order", () => {
  assertCanonical(
    "{\"\u{ffff}\":1,\"\u{1f600}\":2,\"\u{e000}\":3,\"a\":4,\"\":5,\"aa\":6,\"B\":7,\"é\":8}",
    "{\"\":5,\"B\":7,\"a\":4,\"aa\":6,\"é\":8,\"\u{e000}\":3,\"\u{ffff}\":1,\"\u{1f600}\":2}",
  );
  assertCanonical(" { \"b\" : [ 3 , 1 , { \"d\" : null , \"c\" : true } ] , \"a\" : { } } ",
    "{\"a\":{},\"b\":[3,1,{\"c\":true,\"d\":null}]}");
});

test("duplicate keys are rejected, escaped equivalents and nested ones included", () => {
  for (const text of [
    "{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":1}", "{\"b\":1,\"a\":2,\"c\":3,\"a\":4}", "[{\"x\":{\"y\":1,\"y\":1}}]",
    "{\"é\":1,\"\\u00e9\":1}",
  ]) assertRejected(text);
  assert.match(digestOfText("{\"a\":1,\"a\\u0000\":2,\"A\":3}").digest, /^[a-f0-9]{64}$/u);
});

test("identity inputs canonicalize the same whatever their member order and spacing", () => {
  const auth = { principal: "https://issuer.test:josé", subject: "山田", role: "member", session: { b: "2", a: "\u2028\"" } };
  const binding = { version: 1, scope: "tenant", databaseId: "db_1", generation: "1", snapshot: "s" };
  const reversed = (value) => Object.fromEntries(Object.entries(value).reverse());
  const one = core(JSON.stringify({ op: "auth", auth, binding }));
  const two = core(` { "binding" : ${JSON.stringify(reversed(binding))} , "auth" : ${JSON.stringify({ ...reversed(auth), session: reversed(auth.session) })} , "op" : "auth" } `);
  assert.match(one.fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(two, one);
  assert.equal(core(JSON.stringify({ op: "auth", auth, binding: { ...binding, version: 1.0 } })).fingerprint, one.fingerprint);
  assert.notEqual(core(JSON.stringify({ op: "auth", auth: { ...auth, subject: "山田 " }, binding })).fingerprint, one.fingerprint);
});

// A seeded generator of JSON values (no lone surrogates), each printed in two spellings that
// differ in member order, whitespace, string escapes, and the spelling of integers.
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
  const character = () => {
    const ranges = [[0x20, 0x7e], [0x0, 0x1f], [0x7f, 0x7ff], [0x800, 0xd7ff], [0xe000, 0xffff], [0x10000, 0x10ffff]];
    const [low, high] = pick(ranges);
    return String.fromCodePoint(low + int(high - low + 1));
  };
  const text = () => Array.from({ length: int(6) }, character).join("");
  const value = (depth) => {
    switch (depth > 4 ? 2 + int(4) : int(6)) {
      case 0: return Object.fromEntries(Array.from({ length: int(5) }, () => [text(), value(depth + 1)]));
      case 1: return Array.from({ length: int(4) }, () => value(depth + 1));
      case 2: return text();
      case 3: return pick([int(1000) - 500, int(2 ** 53), -int(2 ** 53), 0, 2 ** 53 - 1]);
      case 4: return pick([0.5, -1.25, 1e21, 1e-7, 5e-324, 123.456, random()]);
      default: return pick([true, false, null]);
    }
  };
  const space = () => pick(["", "", " ", "\n", "\t "]);
  // Each non-ASCII character raw, or as `\u` escapes of its UTF-16 code units (a pair for an
  // astral one), in either case.
  const escape = (string) => string.replace(/[^\u0020-\u007e]/gu, (match) => random() < 0.5 ? match
    : Array.from({ length: match.length }, (_, unit) => {
      const hex = match.charCodeAt(unit).toString(16).padStart(4, "0");
      return `\\u${random() < 0.5 ? hex : hex.toUpperCase()}`;
    }).join(""));
  const spell = (item) => {
    if (Array.isArray(item)) return `[${space()}${item.map(spell).join(`${space()},${space()}`)}${space()}]`;
    if (item && typeof item === "object") {
      const entries = Object.entries(item).sort(() => random() - 0.5);
      return `{${space()}${entries.map(([key, inner]) => `"${escape(JSON.stringify(key).slice(1, -1))}"${space()}:${space()}${spell(inner)}`).join(",")}${space()}}`;
    }
    if (typeof item === "string") return `"${escape(JSON.stringify(item).slice(1, -1))}"`;
    if (Number.isSafeInteger(item) && random() < 0.5) return pick([`${item}.0`, `${item}e0`, item === 0 ? "-0" : `${item}0E-1`]);
    return JSON.stringify(item);
  };
  return () => {
    const item = value(0);
    return [JSON.stringify(item), spell(item)];
  };
};

test("deterministic: two spellings of one value have one canonical form", () => {
  const seed = Number(process.env.POLICYSQL_CANONICAL_SEED ?? 0x25_0005);
  const next = generator(seed);
  for (let index = 0; index < 2_000; index++) {
    const [plain, other] = next();
    const label = `seed ${seed} case ${index}: ${JSON.stringify(other)}`;
    const expected = digestOfText(plain);
    assert.match(expected.digest ?? "", /^[a-f0-9]{64}$/u, label);
    assert.deepEqual(digestOfText(other), expected, label);
    assert.deepEqual(digestOfText(plain), expected, `${label} (repeated)`);
  }
});
