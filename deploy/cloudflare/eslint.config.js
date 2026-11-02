import tseslint from "typescript-eslint";

// Lint for the parts of the tree that ship to a Worker (issue #59). The layer boundaries of
// ADR 0019, 0021, 0022 and 0023 are enforced here, by rules that read the syntax tree, rather
// than by hand-written scanners in test/. Every rule is declarative: there is no allowlist of
// spellings to keep in step with the code.
//
// The blocks are disjoint: each file matches exactly one boundary block, because ESLint
// replaces a rule's options (rather than merging them) when a later block matches the same
// file. `test/boundary.test.mjs` pins both the rules and their disjointness.
//
//   engine          src/**, minus the groups below — no HTTP, no platform, no env
//   DO adapter      src/adapters/durable-objects.ts — the one place platform names live
//   HTTP adapters   src/http/** — header names, statuses, and routes are its job
//   outbound        src/adapters/{jwt,commit-check-hook}.ts, src/turso-http.ts,
//                   src/bounded-body.ts, src/redirects.ts — the owner/database/validator wire
//   assembly        src/{worker,package,app}.ts — where HTTP and the platform meet
//   deployment      wrapper/**, dev-validator/** — a Worker too, without the library's rules

/** A reference to `name` as an identifier, member name, property key, or string literal. */
const refs = (name) => [
  `Identifier[name='${name}']`,
  `PrivateIdentifier[name='${name}']`,
  `Literal[value='${name}']`,
  `TemplateLiteral > TemplateElement[value.raw='${name}']`,
];

const restricted = (names, message) => names.flatMap((name) => refs(name).map((selector) => ({
  selector, message: `${name}: ${message}`,
})));

const HTTP = ["Request", "RequestInit", "RequestInfo", "Response", "ResponseInit", "Headers", "HeadersInit", "BodyInit", "Hono"];
const PLATFORM = [
  "DurableObject", "DurableObjectNamespace", "DurableObjectState", "DurableObjectStub", "DurableObjectId",
  "DurableObjectStorage", "DurableObjectNamespaceGetDurableObjectOptions", "DurableObjectNamespaceNewUniqueIdOptions",
  "LoopbackDurableObjectNamespace", "idFromName", "idFromString", "newUniqueId", "getByName", "jurisdiction",
  "storage", "setAlarm", "getAlarm", "deleteAlarm", "waitUntil", "executionCtx", "ExecutionContext",
];
const HEADERS = [
  "content-type", "content-length", "cache-control", "etag", "if-none-match", "idempotency-key", "policysql-role",
  "authorization", "x-content-type-options", "retry-after", "traceparent", "policysql-request-id", "cf-ray",
  "cf-connecting-ip", "x-policysql-request-id", "policysql-hook-version", "policysql-hook-timestamp",
  "policysql-hook-signature",
];
const GLOBAL_OBJECTS = "globalThis|self|window|global";

// An HTTP header name of the public protocol, the owner wire, or the commit-check hook.
const headers = [
  `Literal[value=/^(${HEADERS.join("|")})$/i]`,
  `TemplateElement[value.raw=/^(${HEADERS.join("|")})$/i]`,
].map((selector) => ({ selector, message: "a header name belongs to src/http/ (ADR 0019)" }));

// A public route (`/v1/...` or `/healthz`).
const routes = [
  { selector: "Literal[value=/\\/v1\\//]", message: "a public route belongs to src/http/routes.ts (ADR 0019)" },
  { selector: 'Literal[value="/healthz"]', message: "a public route belongs to src/http/routes.ts (ADR 0019)" },
  { selector: "TemplateElement[value.raw=/\\/v1\\//]", message: "a public route belongs to src/http/routes.ts (ADR 0019)" },
];

// A 3-digit status number in a status position: a `status` / `statusCode` property value, or an
// argument of a call whose callee name says response, error, or status.
const statuses = [
  {
    selector: "Property[key.name='status'] > Literal[value>=100][value<=599], Property[key.name='statusCode'] > Literal[value>=100][value<=599]",
    message: "an HTTP status belongs to src/http/status.ts (ADR 0019)",
  },
  {
    selector: "CallExpression[callee.name=/response|error|status/i] > Literal[value>=100][value<=599], NewExpression[callee.name=/response|error|status/i] > Literal[value>=100][value<=599]",
    message: "an HTTP status belongs to src/http/status.ts (ADR 0019)",
  },
];

// Only the exit may set a redirect mode or call the host fetch (#36): workerd rejects the
// "error" redirect mode, so every outbound call goes through `fetchNoFollow`.
const outboundExit = [
  { name: "fetch", message: "use fetchNoFollow from src/redirects.ts (#36)" },
];
const outboundExitSyntax = [
  { selector: "Identifier[name='redirect']", message: "use fetchNoFollow from src/redirects.ts (#36)" },
  { selector: "Literal[value='redirect']", message: "use fetchNoFollow from src/redirects.ts (#36)" },
  {
    selector: `MemberExpression[object.name=/^(${GLOBAL_OBJECTS})$/][property.name='fetch'], MemberExpression[object.name=/^(${GLOBAL_OBJECTS})$/][property.value='fetch']`,
    message: "use fetchNoFollow from src/redirects.ts (#36)",
  },
];

// No deployment setting is read from an environment object (ADR 0021): an `env` or
// `deployment` value may be passed on, never read, aliased, or stored.
const envUse = [
  {
    selector: "MemberExpression[object.name='env'], MemberExpression[object.name='deployment'], MemberExpression[object.property.name='env'], MemberExpression[object.property.value='env'], MemberExpression[object.property.name='deployment'], MemberExpression[object.property.value='deployment'], MemberExpression[object.name='process'][property.name='env'], MemberExpression[object.name='process'][property.value='env'], MemberExpression[object.type='ThisExpression'][property.name='env'], MemberExpression[object.type='ThisExpression'][property.value='env']",
    message: "library code reads no deployment setting from an environment object (ADR 0021): take PolicySqlConfig",
  },
  {
    selector: "AssignmentExpression[right.name='env'], AssignmentExpression[right.name='deployment'], AssignmentExpression[right.property.name='env'], AssignmentExpression[right.property.value='env'], AssignmentExpression[right.property.name='deployment'], VariableDeclarator[init.property.name='env'], VariableDeclarator[init.property.name='deployment'], VariableDeclarator > Identifier[name='env'], VariableDeclarator > Identifier[name='deployment'], VariableDeclarator[init.name='env'] > ObjectPattern, VariableDeclarator[init.name='deployment'] > ObjectPattern, VariableDeclarator[init.property.name='env'] > ObjectPattern, VariableDeclarator[init.property.value='env'] > ObjectPattern, VariableDeclarator[init.property.name='deployment'] > ObjectPattern, TSNonNullExpression > Identifier[name='env'], TSNonNullExpression > Identifier[name='deployment']",
    message: "an environment object may be passed on, never bound to another name (ADR 0021)",
  },
  {
    selector: "ObjectExpression > Property[value.name='env'], ObjectExpression > Property[value.name='deployment'], SpreadElement > Identifier[name='env'], SpreadElement > Identifier[name='deployment'], ArrayExpression > Identifier[name='env'], ArrayExpression > Identifier[name='deployment']",
    message: "an environment object may be passed on, never stored (ADR 0021)",
  },
  {
    selector: "CallExpression:not(:matches([callee.name='deployment'], [callee.name='build'], [callee.name='appFor'], [callee.object.name='apps'][callee.property.name='get'], [callee.object.name='apps'][callee.property.name='set'])) > Identifier[name='env'], NewExpression > Identifier[name='env'], NewExpression > Identifier[name='deployment']",
    message: "an environment object reaches only the deployment sinks: deployment(), build(), appFor() (ADR 0021)",
  },
];

const DO_ADAPTER = "src/adapters/durable-objects.ts";
const HTTP_ADAPTERS = "src/http/**";
const OUTBOUND = ["src/adapters/jwt.ts", "src/adapters/commit-check-hook.ts", "src/turso-http.ts", "src/bounded-body.ts", "src/redirects.ts"];
const ASSEMBLY = ["src/worker.ts", "src/package.ts", "src/app.ts"];
const NOT_ENGINE = [HTTP_ADAPTERS, DO_ADAPTER, ...OUTBOUND, ...ASSEMBLY];

export default tseslint.config(
  // Generated: wasm-pack's declarations and the staged policy (scripts/stage-policy.mjs).
  { ignores: ["pkg/**", "node_modules/**", ".wrangler*/**", "src/policy-staged.ts"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },

  {
    // The engine. `tsconfig.engine.json` already makes an HTTP or platform *type* a compile
    // error; these rules cover what types cannot: the global `fetch`, a header name, a status,
    // a route string, and every way of reaching an environment object.
    files: ["src/**/*.ts"],
    ignores: NOT_ENGINE,
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "outbound HTTP goes through src/redirects.ts (#36)" },
        ...HTTP.map((name) => ({ name, message: "HTTP belongs to src/http/ (ADR 0019)" })),
      ],
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "hono", message: "HTTP belongs to src/http/ (ADR 0019)" }], patterns: ["hono/*"] },
      ],
      "no-restricted-syntax": [
        "error",
        ...restricted(HTTP, "HTTP belongs to src/http/ (ADR 0019)"),
        ...restricted(PLATFORM, "the platform belongs to src/adapters/ (ADR 0022)"),
        ...headers,
        ...routes,
        ...statuses,
        ...outboundExitSyntax,
        ...envUse,
      ],
    },
  },
  {
    // The Durable Objects adapter: the one module that may name a platform name. It speaks
    // HTTP to the owner's own wire (`https://owner/<command>`), so HTTP is its job too, but it
    // still reads no deployment setting from an environment object.
    files: [DO_ADAPTER],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...outboundExitSyntax,
        // The adapter hands its env to `deployment(env)`, the one documented sink.
        ...envUse.filter((rule) => rule !== envUse[3]),
        {
          selector: "CallExpression:not([callee.name='deployment']) > Identifier[name='env']",
          message: "the adapter hands its env to deployment(env) and to nothing else (ADR 0021)",
        },
      ],
    },
  },
  {
    // The inbound HTTP adapters: header names, statuses, and routes are exactly their job.
    // The platform is not, and neither is a deployment setting: Hono's `c.env` is the bindings
    // the adapter built, and only `c.env.context` / `c.env.background` are readable.
    files: [HTTP_ADAPTERS],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restricted(PLATFORM, "the platform belongs to src/adapters/durable-objects.ts (ADR 0022)"),
        ...envUse.filter((rule) => rule !== envUse[0] && rule !== envUse[3]),
        {
          selector: "MemberExpression[object.name='env'], MemberExpression[object.name='deployment'], MemberExpression[object.name!='c'][property.name='env'], MemberExpression[object.name!='c'][property.value='env'], MemberExpression[object.name!='c'][property.name='deployment'], MemberExpression[object.property.name='env']:not([property.name='context']):not([property.name='background']), MemberExpression[object.property.name='deployment']",
          message: "the only `.env` member the adapter reads is Hono's `c.env.context` / `c.env.background` (ADR 0021)",
        },
        {
          selector: "MemberExpression[object.property.name='env']:not([object.name='c']):not([property.name='context']):not([property.name='background'])",
          message: "Hono's context exposes only `c.env.context` and `c.env.background` (ADR 0021)",
        },
      ],
    },
  },
  {
    // The outbound adapters: the owner wire, the Turso transport, the validator hook, the
    // bounded body reader, and the one HTTP exit. They speak HTTP, they name no platform name,
    // and only the exit may call the host fetch.
    files: OUTBOUND,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restricted(PLATFORM, "the platform belongs to src/adapters/durable-objects.ts (ADR 0022)"),
        ...outboundExitSyntax,
        ...envUse,
      ],
    },
  },
  {
    // src/redirects.ts is the exit: it is the one module allowed to set the redirect mode and
    // call the host fetch, so it gets no outbound rule.
    files: ["src/redirects.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restricted(PLATFORM, "the platform belongs to src/adapters/durable-objects.ts (ADR 0022)"),
        ...envUse,
      ],
    },
  },
  {
    // The assembly: where the Workers entry signatures, `ExecutionContext`, and the deployment
    // function meet (ADR 0023). HTTP and the platform are its job; the environment object is
    // passed to the sinks and never read.
    files: ASSEMBLY,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restricted(PLATFORM, "the platform belongs to src/adapters/durable-objects.ts (ADR 0022)").filter(
          (rule) => !rule.selector.includes("ExecutionContext") && !rule.selector.includes("waitUntil"),
        ),
        // The assembly passes the environment object to the deployment, the app cache, and the
        // entry signatures by design. What it may never do is read a setting out of it, or
        // store the object where a later read could: the first and the third rule of `envUse`.
        ...envUse.filter((rule) => rule === envUse[0] || rule === envUse[2]),
      ],
    },
  },
  {
    // Deployment code: a Worker too, but not the library. It may read its own env; it may not
    // call the host fetch or set a redirect mode.
    files: ["wrapper/**/*.ts", "dev-validator/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", ...outboundExit],
      "no-restricted-syntax": ["error", ...outboundExitSyntax],
    },
  },
);
