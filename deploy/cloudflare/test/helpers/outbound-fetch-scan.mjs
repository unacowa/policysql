import ts from "typescript";

// Structural scan for outbound HTTP in Worker-executed source (#36). It parses each
// file and inspects syntax nodes, so comments and string contents never match.
//
// Findings:
// - "redirect": any `redirect` identifier, property key (plain, shorthand, quoted,
//   computed) or member access (`init.redirect`, `init["redirect"]`), or a string
//   literal equal to "redirect". Only src/redirects.ts may set the redirect mode.
// - "global-fetch": a reference to the global `fetch` as a value (`fetch(...)`,
//   `fetchImpl = fetch`) or through a global object (`globalThis.fetch`,
//   `self["fetch"]`). Outbound HTTP must go through fetchNoFollow.
//
// Not findings (documented exceptions): member calls on other objects, such as a
// Durable Object stub's `owner.fetch(...)`, a Hono `app.fetch(...)` or a service
// binding, and declarations named `fetch` (a Worker's exported handler). jose's
// remote JWKS fetch lives in node_modules and is outside the scanned trees.
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window", "global"]);

const scriptKind = (file) => {
  if (/\.[cm]?ts$/u.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
};

const literalText = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const inTypeContext = (node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
  }
  return false;
};

// Is this `fetch` identifier a name slot rather than a reference to a binding?
const isNameSlot = (node) => {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)
    || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isGetAccessor(parent)
    || ts.isSetAccessor(parent) || ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)
    || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)) && parent.name === node) return true;
  return false;
};

export const scanOutboundFetch = (file, text) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const findings = [];
  const report = (kind, node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ kind, file, line: line + 1, text: node.getText(source) });
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === "redirect") report("redirect", node);
    else if (literalText(node) === "redirect") report("redirect", node);
    else if (ts.isIdentifier(node) && node.text === "fetch" && !isNameSlot(node) && !inTypeContext(node)) {
      // A shorthand `{ fetch }` reads the binding, so it is a reference too.
      report("global-fetch", node);
    } else if (
      ts.isPropertyAccessExpression(node) && node.name.text === "fetch"
      && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)
    ) report("global-fetch", node);
    else if (
      ts.isElementAccessExpression(node) && literalText(node.argumentExpression) === "fetch"
      && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)
    ) report("global-fetch", node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};
