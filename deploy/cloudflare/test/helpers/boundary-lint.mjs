import { ESLint } from "eslint";

// The layer boundaries of ADR 0019/0021/0022/0023 and the outbound-HTTP rule of #36 are
// lint rules now (eslint.config.js, issue #59). Tests use this helper to ask the same
// question the reviewer does: does a given snippet, in a given module, break a boundary?
//
// `lint(files, text)` lints `text` as if it were each of `files` and returns the messages.
// A probe names a module because the rules are per-directory: `src/engine.ts` is the engine,
// `src/http/adapter.ts` is an inbound adapter, `wrapper/index.ts` is deployment code.
const eslint = new ESLint({ cwd: new URL("../..", import.meta.url).pathname });

/** The lint messages for `text` as the module `file`. */
export const lintAs = async (file, text) => {
  const [result] = await eslint.lintText(text, { filePath: file });
  return result.messages;
};

/** Every boundary finding in the tree, as `file:line ruleId message`. */
export const lintTree = async () => {
  const results = await eslint.lintFiles(["src", "wrapper", "dev-validator"]);
  return results.flatMap((result) => result.messages.map((message) =>
    `${result.filePath.replace(/^.*?deploy\/cloudflare\//u, "")}:${message.line} ${message.ruleId} ${message.message}`));
};

/**
 * The one assertion every probe makes: a forbidden form is caught *in the module that must
 * not have it*, and the same text is accepted where it belongs. The second half keeps the
 * rule from "passing" because it fires on everything.
 */
export const expectBoundary = async (assert, { caught, allowed }) => {
  for (const [file, text] of caught) assert.notDeepEqual(await lintAs(file, text), [], `${file}: ${text}`);
  for (const [file, text] of allowed) assert.deepEqual(await lintAs(file, text), [], `${file}: ${text}`);
};
