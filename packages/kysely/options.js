import { validateKey, validateExpect } from "../client/protocol.js";

const tokens = new WeakMap();
// Preserve the ownership marker when a plugin spreads the root but drops endModifiers.
// Standard Kysely AST transformers instead preserve the typed RawNode below.
const ownership = Symbol("PolicySQL query options");
const empty = Object.freeze({});
const marker = "POLICYSQL_OPTIONS_REQUIRE_POLICYSQL_DIALECT(";
const isMarker = (value) => value?.kind === "RawNode" && value.sqlFragments?.[0] === marker;
const operations = new Set(["SelectQueryNode", "InsertQueryNode", "UpdateQueryNode", "DeleteQueryNode"]);
export const operation = (node) => {
  if (!operations.has(node?.kind)) throw new TypeError("unsupported PolicySQL query operation");
  return node.kind.replace("QueryNode", "").toLowerCase();
};
const contextOf = (modifier) => tokens.get(modifier?.parameters?.[0]?.value);

// A typed RawNode modifier transports a private, opaque token to our compiler. It is
// removed BEFORE SQL emission and never becomes SQL or a bound parameter. Unlike a
// queryId slot, the token belongs to this transformed tree, including compile-only calls.
export const policyOptions = (options = {}) => {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
    Object.keys(options).some((key) => !["idempotencyKey", "expect", "onResponse"].includes(key))) {
    throw new TypeError("invalid policyOptions");
  }
  const idempotencyKey = validateKey(options.idempotencyKey);
  const expect = validateExpect(options.expect);
  const onResponse = options.onResponse;
  if (onResponse !== undefined && typeof onResponse !== "function") throw new TypeError("onResponse must be a function");
  const settings = Object.freeze({ idempotencyKey, expect, onResponse });
  return Object.freeze({
    transformQuery({ node }) {
      operation(node);
      if (node[ownership] || node.endModifiers?.some(contextOf)) throw new TypeError("duplicate policyOptions plugin");
      const token = Object.freeze({});
      const modifier = Object.freeze({
        kind: "RawNode",
        // Fail rather than silently executing the query with an unrelated dialect.
        sqlFragments: Object.freeze([marker, ")"]),
        parameters: Object.freeze([Object.freeze({ kind: "ValueNode", value: token })]),
      });
      const root = Object.freeze({ ...node, [ownership]: token, endModifiers: Object.freeze([...(node.endModifiers ?? []), modifier]) });
      tokens.set(token, { root, modifier, settings });
      return root;
    },
    async transformResult({ result }) { return result; },
  });
};

export const extractOptions = (node) => {
  operation(node);
  const owner = tokens.get(node[ownership]);
  if (owner && owner.root !== node) throw new TypeError("policyOptions must be the last query plugin");
  let found;
  for (const modifier of node.endModifiers ?? []) {
    const context = contextOf(modifier);
    if (!context) {
      if (isMarker(modifier)) throw new TypeError("policyOptions must be the last query plugin");
      continue;
    }
    if (found || context.root !== node || context.modifier !== modifier) {
      throw new TypeError("policyOptions must be the last query plugin");
    }
    found = context;
  }
  if (owner && found !== owner) throw new TypeError("policyOptions must be the last query plugin");
  let clean = node;
  if (found) {
    const { [ownership]: _owner, ...plain } = node;
    clean = Object.freeze({ ...plain, endModifiers: Object.freeze(node.endModifiers.filter((item) => item !== found.modifier)) });
  }
  // Per-query settings on a subquery are ambiguous; only the executed root can own them.
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    // Bound values are application data, including objects resembling AST nodes.
    if (value.kind === "ValueNode" || value.kind === "PrimitiveValueListNode") return;
    if (tokens.has(value[ownership]) || contextOf(value) || isMarker(value)) throw new TypeError("policyOptions must be attached to the executed root query");
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === "object") visit(item);
    }
  };
  // The executed root has already been verified; scan its children for nested settings.
  Object.values(clean).forEach(visit);
  return { node: clean, options: found?.settings ?? empty };
};
