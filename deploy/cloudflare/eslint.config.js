import tseslint from "typescript-eslint";

// Lint for the parts of the tree that ship to a Worker. `any` is rejected outright (issue
// #44): a value that crosses a boundary (a driver reply, a core result, a platform binding)
// is `unknown` until it has been narrowed, so the narrowing that makes it safe is in the
// code rather than in a reviewer's head.
//
// The boundary rules of ADR 0019/0021/0022/0023 live in eslint-boundaries.mjs and are added
// for the engine by tsconfig.engine.json; this file holds only rules that apply everywhere.
export default tseslint.config(
  {
    // Generated: wasm-pack's declarations and the staged policy (scripts/stage-policy.mjs).
    ignores: ["pkg/**", "node_modules/**", ".wrangler*/**", "src/policy-staged.ts"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-restricted-types": "off",
    },
  },
);
