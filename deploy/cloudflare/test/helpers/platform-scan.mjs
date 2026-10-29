import ts from "typescript";

// Structural guard for Cloudflare platform names in library source (#31, ADR 0022). It
// parses each file and inspects syntax nodes, so comments never match. Every identifier
// (value or type position, declaration or reference, property name or member) and every
// string literal whose text is one of these names is a finding. Only the Durable Objects
// adapter module may contain them.
export const PLATFORM_NAMES = new Set([
  // Durable Object routing and types.
  "DurableObject", "DurableObjectNamespace", "DurableObjectState", "DurableObjectStub", "DurableObjectId",
  "DurableObjectStorage", "DurableObjectNamespaceGetDurableObjectOptions",
  "DurableObjectNamespaceNewUniqueIdOptions", "LoopbackDurableObjectNamespace",
  // Every DurableObjectNamespace method: get / getByName / idFromName / idFromString /
  // newUniqueId / jurisdiction (`get` alone is too common a name to ban; its namespace
  // can only come from one of the others or from the banned types).
  "idFromName", "idFromString", "newUniqueId", "getByName", "jurisdiction",
  // Durable Object state: storage and its alarm.
  "storage", "setAlarm", "getAlarm", "deleteAlarm",
  // Background continuation (Durable Object state, Workers ExecutionContext, Hono's accessor).
  "waitUntil", "executionCtx",
  // The platform module (env, RPC base classes).
  "cloudflare:workers",
]);

const literalText = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

export const scanPlatformNames = (file, text) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const visit = (node) => {
    const name = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : literalText(node);
    if (name !== undefined && PLATFORM_NAMES.has(name)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({ file, line: line + 1, name });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};
