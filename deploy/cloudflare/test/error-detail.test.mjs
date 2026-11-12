import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPLEXITY_DETAILS, EXPECTATIONS, MAX_SPAN_OFFSET, PARAMETER_REASONS, UNSUPPORTED_FEATURES, checkedErrorDetail,
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
  const block = source.match(new RegExp(`${name}: \\[&str; (\\d+)\\] = \\[([^\\]]*)\\];`, "u"));
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
  ]) {
    const core = constantList(io, constant);
    assert.equal(new Set(core).size, core.length, `${constant}: no duplicates`);
    assert.deepEqual(core, [...worker], `${constant}: core and the Worker`);
    assert.deepEqual(openapiEnum(property), core, `${constant}: OpenAPI ${property}`);
    assert.deepEqual(typeUnion(union), core, `${constant}: the client's ${union}`);
  }
  const maxSpan = io.match(/pub const MAX_SPAN_OFFSET: u64 = ([0-9_]+);/u);
  assert.ok(maxSpan, "core declares MAX_SPAN_OFFSET");
  assert.equal(Number(maxSpan[1].replaceAll("_", "")), MAX_SPAN_OFFSET);
  assert.match(component, new RegExp(`start: \\{ type: integer, minimum: 0, maximum: ${MAX_SPAN_OFFSET} \\}`, "u"));
  assert.match(component, new RegExp(`end: \\{ type: integer, minimum: 0, maximum: ${MAX_SPAN_OFFSET} \\}`, "u"));
  // The Rust types' own names (`UnsupportedFeature::ALL`, `ParameterReason::ALL`, `ComplexityCause::ALL`,
  // `ExpectationKind::ALL`) are compared with core's constants variant for variant by
  // `the_detail_enumerations_are_the_rust_types_and_core_keeps_them` in crates/policysql-wasm.
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
