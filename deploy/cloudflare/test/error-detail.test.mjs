import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMIT_CHECK_REASONS, COMPLEXITY_DETAILS, EXCEEDED_LIMITS, EXPECTATIONS, MAX_SPAN_OFFSET, PARAMETER_REASONS, REQUEST_LIMITS,
  TRANSACTION_LIMITS, UNSUPPORTED_FEATURES, checkedErrorDetail,
} from "../src/error-detail.ts";

// `error.detail` of #145 pull request C: the table that core (`ErrorDetail::allowed`) and the
// Worker (`checkedErrorDetail`) apply to every error another party hands over, the enumerations
// both keep, and the public forms that list them (OpenAPI, the client's types).
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(join(repository, path), "utf8");

const cases = JSON.parse(read("tests/fixtures/error-detail-cases.json"));

const deepFrozen = (value) => value === null || typeof value !== "object"
  || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

// The same fixture drives `the_shared_fixture_is_judged_as_the_worker_judges_it` in core.
test("the Worker judges the shared fixture as core does", () => {
  assert.ok(cases.length > 200, `${cases.length} cases`);
  for (const [index, entry] of cases.entries()) {
    const label = `#${index} ${entry.code} ${JSON.stringify(entry.detail)} (${entry.valid ? "valid" : "invalid"})`;
    const hasDetail = Object.hasOwn(entry, "detail");
    // `undefined` is "no detail"; a JSON `null` is a detail that is not an object.
    const checked = checkedErrorDetail(entry.code, hasDetail ? entry.detail : undefined);
    if (entry.valid) {
      assert.notEqual(checked, null, label);
      if (hasDetail) {
        assert.deepEqual(checked, entry.detail, label);
        assert.ok(deepFrozen(checked), `${label}: a frozen copy`);
        assert.notEqual(checked, entry.detail, `${label}: shares nothing with the input`);
      } else {
        assert.equal(checked, undefined, label);
      }
    } else {
      assert.equal(checked, null, label);
    }
  }
});

test("a JSON number such as 1.0 is not in the fixture, because JavaScript cannot tell it from 1", () => {
  assert.equal(read("tests/fixtures/error-detail-cases.json").includes("1.0"), false);
});

const constantList = (source, name) => {
  const block = source.match(new RegExp(`${name}: \\[&str; (\\d+)\\] =\\s*\\[([^\\]]*)\\];`, "u"));
  assert.ok(block, `core declares ${name}`);
  const values = [...block[2].matchAll(/"([A-Za-z_]+)"/gu)].map((match) => match[1]);
  assert.equal(values.length, Number(block[1]), `${name} length`);
  return values;
};

test("the enumerations are the same in core, the Worker, OpenAPI, and the client's types", () => {
  const io = read("crates/policysql-transaction/src/machine/io.rs");
  const openapi = read("spec/openapi.yaml");
  const types = read("packages/client/index.d.ts");
  const component = openapi.slice(openapi.indexOf("    ErrorDetail:\n"), openapi.indexOf("    ErrorResponse:\n"));
  const openapiEnum = (property) => {
    const found = component.match(new RegExp(`\\n        ${property}:\\n(?:          [^\\n]*\\n)*?          enum: \\[([^\\]]*)\\]`, "u"));
    assert.ok(found, `OpenAPI ErrorDetail.${property} has an enum`);
    return found[1].split(",").map((item) => item.trim().replaceAll('"', ""));
  };
  const typeUnion = (name) => {
    const found = types.match(new RegExp(`export type ${name} =([^\\n]*(?:\\n  \\|[^\\n]*)*)`, "u"));
    assert.ok(found, `the client declares ${name}`);
    return [...found[1].matchAll(/'([A-Za-z_]+)'/gu)].map((match) => match[1]);
  };
  for (const [constant, worker, property, union] of [
    ["UNSUPPORTED_FEATURES", UNSUPPORTED_FEATURES, "feature", "PolicySqlUnsupportedFeature"],
    ["PARAMETER_REASONS", PARAMETER_REASONS, "reason", "PolicySqlParameterReason"],
    ["COMPLEXITY_DETAILS", COMPLEXITY_DETAILS, "complexity", "PolicySqlComplexity"],
    ["EXPECTATIONS", EXPECTATIONS, "expectation", "PolicySqlExpectation"],
    ["COMMIT_CHECK_REASONS", COMMIT_CHECK_REASONS, "reason", "PolicySqlCommitCheckReason"],
  ]) {
    const core = constantList(io, constant);
    assert.equal(new Set(core).size, core.length, `${constant}: no duplicates`);
    assert.deepEqual(core, [...worker], `${constant}: core and the Worker`);
    // `reason` is one OpenAPI property for two codes: the parameter reasons, then the commit check's.
    const openapi = constant === "COMMIT_CHECK_REASONS" ? openapiEnum(property).slice(PARAMETER_REASONS.length) : openapiEnum(property);
    if (constant === "PARAMETER_REASONS") assert.deepEqual(openapiEnum(property).slice(0, core.length), core, "OpenAPI: the parameter reasons come first");
    if (constant !== "PARAMETER_REASONS") assert.deepEqual(openapi, core, `${constant}: OpenAPI ${property}`);
    assert.deepEqual(typeUnion(union), core, `${constant}: the client's ${union}`);
  }
  const reasons = openapiEnum("reason");
  assert.equal(reasons.length, PARAMETER_REASONS.length + COMMIT_CHECK_REASONS.length, "OpenAPI reason is exactly the two lists");
  assert.equal(new Set(reasons).size, reasons.length, "the two reason lists share no value");
  // `limit` is one OpenAPI property and one client type for three codes, each with a list of its
  // own: the public form is the union of the three, in the order of their first appearance
  // (`EXCEEDED_LIMITS`, then what `REQUEST_LIMITS` adds, then `TRANSACTION_LIMITS`).
  const limitLists = [["EXCEEDED_LIMITS", EXCEEDED_LIMITS], ["REQUEST_LIMITS", REQUEST_LIMITS], ["TRANSACTION_LIMITS", TRANSACTION_LIMITS]];
  for (const [constant, worker] of limitLists) {
    const core = constantList(io, constant);
    assert.equal(new Set(core).size, core.length, `${constant}: no duplicates`);
    assert.deepEqual(core, [...worker], `${constant}: core and the Worker`);
  }
  const limits = [...new Set(limitLists.flatMap(([, worker]) => worker))];
  assert.equal(limits.length, 14, "the three lists name 14 limits");
  assert.deepEqual(openapiEnum("limit"), limits, "OpenAPI limit is the union of the three lists");
  assert.deepEqual(typeUnion("PolicySqlLimit"), limits, "the client's PolicySqlLimit is the union of the three lists");
  const maxSpan = io.match(/pub const MAX_SPAN_OFFSET: u64 = ([0-9_]+);/u);
  assert.ok(maxSpan, "core declares MAX_SPAN_OFFSET");
  assert.equal(Number(maxSpan[1].replaceAll("_", "")), MAX_SPAN_OFFSET);
  assert.match(component, new RegExp(`start: \\{ type: integer, minimum: 0, maximum: ${MAX_SPAN_OFFSET} \\}`, "u"));
  assert.match(component, new RegExp(`end: \\{ type: integer, minimum: 0, maximum: ${MAX_SPAN_OFFSET} \\}`, "u"));
  // The Rust types' own names (`UnsupportedFeature::ALL`, `ParameterReason::ALL`, `ComplexityCause::ALL`,
  // `ExpectationKind::ALL`) are compared with core's constants variant for variant by
  // `the_detail_enumerations_are_the_rust_types_and_core_keeps_them` in crates/policysql-wasm.
});

test("the limit codes take their own list, or no detail", () => {
  for (const [code, list] of [
    ["POLICYSQL_LIMIT_EXCEEDED", EXCEEDED_LIMITS], ["POLICYSQL_REQUEST_TOO_LARGE", REQUEST_LIMITS],
    ["POLICYSQL_TRANSACTION_LIMIT_EXCEEDED", TRANSACTION_LIMITS],
  ]) {
    assert.equal(checkedErrorDetail(code, undefined), undefined, `${code}: a bound without a name has no detail`);
    for (const limit of [...EXCEEDED_LIMITS, ...REQUEST_LIMITS, ...TRANSACTION_LIMITS]) {
      const checked = checkedErrorDetail(code, { limit });
      if (list.includes(limit)) assert.deepEqual(checked, { limit }, `${code} ${limit}`);
      else assert.equal(checked, null, `${code} ${limit}: another code's value`);
    }
    for (const detail of [null, {}, { limit: "timeoutMs" }, { limit: "limits.maxRows" }, { limit: "MAXROWS" }, { limit: 100 },
      { limit: ["maxRows"] }, { limit: list[0], value: 1 }, { reason: "denied" }]) {
      assert.equal(checkedErrorDetail(code, detail), null, `${code} ${JSON.stringify(detail)}`);
    }
  }
  assert.equal(checkedErrorDetail("POLICYSQL_INVALID_PARAMETER", { limit: "maxRows" }), null);
  assert.equal(checkedErrorDetail("POLICYSQL_COMMIT_CHECK_REJECTED", { limit: "maxRows" }), null);
});

test("an optional detail may be absent, a required one may not, and a code without a row has none", () => {
  assert.equal(checkedErrorDetail("POLICYSQL_INVALID_SQL", undefined), undefined);
  assert.equal(checkedErrorDetail("POLICYSQL_UNSUPPORTED_SQL", undefined), null);
  assert.equal(checkedErrorDetail("POLICYSQL_FORBIDDEN_COLUMN", undefined), undefined);
  assert.equal(checkedErrorDetail("POLICYSQL_FORBIDDEN_COLUMN", { feature: "star" }), null);
  assert.equal(checkedErrorDetail("POLICYSQL_INVALID_SQL", null), null);
  assert.equal(checkedErrorDetail("POLICYSQL_INVALID_SQL", {}), null);
  // An object with a prototype, an accessor that lies, or a non-plain value is not a detail.
  assert.equal(checkedErrorDetail("POLICYSQL_UNSUPPORTED_SQL", Object.create({ feature: "star" })), null);
  assert.equal(checkedErrorDetail("POLICYSQL_UNSUPPORTED_SQL", new Map([["feature", "star"]])), null);
  // A cause with an explicit undefined detail is not the `null` that means "none".
  assert.equal(checkedErrorDetail("POLICYSQL_OUTCOME_UNKNOWN", { cause: { code: "POLICYSQL_FORBIDDEN_COLUMN", path: null, detail: undefined } }), null);
});
