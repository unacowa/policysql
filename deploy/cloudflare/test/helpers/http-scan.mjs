import ts from "typescript";

// Structural guard for HTTP in engine modules (#34, ADR 0019, ADR 0023). It parses each file
// and inspects syntax nodes, so comments never match. A finding is any of:
//
// - "http-type": an identifier `Request`, `Response`, `Headers`, or `Hono` in any position
//   (value or type, construction, reference, or property name), or an import from `hono`;
// - "header-name": a string or template literal whose text, lower-cased, is an HTTP header
//   name of the public protocol, the owner wire, or the commit-check hook (HEADER_NAMES);
// - "route": a string or template literal (any part of a template) that contains `/v1/` or is
//   `/healthz`;
// - "status": a numeric literal from 100 to 599 that is the value of a property named
//   `status` or `statusCode`, is assigned to or compared with a `.status` / `.statusCode`
//   member, or is an argument of a call or `new` whose callee name contains `response`,
//   `error`, or `status`, in any case (for example `new SomeError(409, ...)`, `json(body, 404)`).
export const HTTP_TYPES = new Set(["Request", "Response", "Headers", "Hono"]);
export const HEADER_NAMES = new Set([
  "content-type", "content-length", "cache-control", "etag", "if-none-match", "idempotency-key", "policysql-role",
  "authorization", "x-content-type-options", "retry-after", "traceparent", "policysql-request-id", "cf-ray",
  "cf-connecting-ip", "x-policysql-request-id", "policysql-hook-version", "policysql-hook-timestamp",
  "policysql-hook-signature",
]);
const STATUS_NAMES = new Set(["status", "statusCode"]);
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsToken,
]);

const isStatusMember = (node) => ts.isPropertyAccessExpression(node) && STATUS_NAMES.has(node.name.text);
const calleeName = (callee) => ts.isIdentifier(callee) ? callee.text
  : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
const statusLike = (node) => {
  if (!ts.isNumericLiteral(node)) return false;
  const value = Number(node.text);
  return Number.isInteger(value) && value >= 100 && value <= 599;
};

const statusContext = (node) => {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) && STATUS_NAMES.has(parent.name.text)) return true;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) {
    return isStatusMember(parent.left === node ? parent.right : parent.left);
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node)) {
    return /response|error|status/iu.test(calleeName(parent.expression));
  }
  return false;
};

const literalTexts = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  return [];
};

export const scanHttp = (file, text) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const report = (kind, node, detail) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ kind, file, line: line + 1, text: detail ?? node.getText(source) });
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && HTTP_TYPES.has(node.text)) report("http-type", node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      /^hono(\/|$)/u.test(node.moduleSpecifier.text)) report("http-type", node, node.moduleSpecifier.text);
    // A template's parts are checked once, on the whole template.
    if (!ts.isTemplateHead(node) && !ts.isTemplateMiddle(node) && !ts.isTemplateTail(node)) {
      for (const part of literalTexts(node)) {
        if (HEADER_NAMES.has(part.toLowerCase())) report("header-name", node, part);
        if (part.includes("/v1/") || part === "/healthz") report("route", node, part);
      }
    }
    if (statusLike(node) && statusContext(node)) report("status", node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};
