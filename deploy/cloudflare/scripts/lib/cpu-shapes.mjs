// Request body shapes for CPU measurement (ADR 0027, "Measurements").
//
// Provenance: the shapes and their sizes are the ones the ADR 0027 author measured for #56
// (bench scripts bench.test.mjs and cells.test.mjs, October 2026, run against origin/main
// f44fcdb); they are reproduced here so the numbers can be re-measured from the repository.
// Each generator returns a JSON value that fills about `target` bytes of request body.
//
// Shared by scripts/measure-cpu.mjs (Node, the reference machine) and the release smoke
// (scripts/provision-dev.mjs, the deployed Worker), so both sides use the same shape.

/** Fills an array with `make(i)` until its JSON text is about `target - slack` bytes. */
const fill = (make, target, slack = 200) => {
  const out = [];
  let length = 0;
  for (let i = 0; length < target - slack; i += 1) {
    const value = make(i);
    out.push(value);
    length += JSON.stringify(value).length + 1;
  }
  return out;
};

const nestedLeaf = (depth) => {
  let value = 1;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
};

/**
 * Named JSON values (a `metadata` parameter) of about `target` bytes. `values` of a shape is
 * `countJsonValues(value)`, never hard-coded: the count is the model's `V`.
 */
export const REQUEST_SHAPES = Object.freeze({
  // The ADR's densest body: depth 56, about 0.5 values per byte.
  "nested arrays (depth 56)": (target) => fill(() => nestedLeaf(55), target),
  "one object, unique keys": (target) => {
    const object = {};
    let length = 0;
    for (let i = 0; length < target - 200; i += 1) {
      object[`k${i}`] = 1;
      length += `"k${i}":1,`.length;
    }
    return object;
  },
  'short strings "s1"': (target) => fill((i) => `s${i % 10}`, target),
  "short decimals 37.4": (target) => fill((i) => Number(`${i % 100}.${i % 10 || 1}`), target),
  "small integers": (target) => fill((i) => i % 1000, target),
  "17-digit decimals": (target) => fill((i) => Number(`${90071992547409 + i * 7}.${String(i % 1000).padStart(3, "0")}`), target),
  "one long ASCII string": (target) => ({ s: "x".repeat(target - 200) }),
  "one long CJK string": (target) => ({ s: "日".repeat(Math.floor((target - 200) / 3)) }),
});

/** Request shapes the release smoke sends to the deployed Worker (a subset of `REQUEST_SHAPES`). */
export const SMOKE_SHAPES = Object.freeze(["nested arrays (depth 56)", "short decimals 37.4", "one long ASCII string"]);

/**
 * The number of JSON values in `value`: every value (scalars, arrays, objects) plus every
 * object member name, the way ADR 0027 counts `V_req`.
 */
export const countJsonValues = (value) => {
  let count = 0;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    count += 1;
    if (Array.isArray(current)) for (const child of current) stack.push(child);
    else if (current !== null && typeof current === "object") {
      for (const [, child] of Object.entries(current)) {
        count += 1;
        stack.push(child);
      }
    }
  }
  return count;
};
