import ts from "typescript";

// Structural scan for platform-environment reads in library source (#32, ADR 0021). It
// parses each file and inspects syntax nodes, so comments and string contents never match.
//
// Findings:
// - "env-read": a member read on an object named `env` or `deployment` (`env.X`,
//   `env["X"]`, `env[name]`, `deployment.X`), on `this.env`, or on a `.deployment`
//   member (`context.env.deployment.X`); destructuring from such an object
//   (`const { X } = env`); and `process.env`.
// - "hono-binding": `<expr>.env.X` where X is not one of the Hono bindings that `app.fetch`
//   builds itself (HONO_BINDINGS). Those are typed per-request values, never the
//   platform env, so reading them is not a configuration read.
// - "platform-import": an import from `cloudflare:workers`, which exposes the platform env
//   as a module export.
//
// The single documented exception, `env.TRANSACTION_OWNER` in src/app.ts, is reported like
// any other read; the test asserts it is the only one.
const ENV_OBJECTS = new Set(["env", "deployment"]);
export const HONO_BINDINGS = new Set(["transactionOwner", "databaseBinding", "session", "requestId", "callback"]);

const memberName = (node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) return argument.text;
  return "[computed]";
};

// Is `node` itself an environment object reference?
const isEnvObject = (node) => {
  if (ts.isParenthesizedExpression(node)) return isEnvObject(node.expression);
  if (ts.isIdentifier(node)) return ENV_OBJECTS.has(node.text);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = memberName(node);
    if (name === "deployment") return true;
    if (name === "env" && (node.expression.kind === ts.SyntaxKind.ThisKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "process"))) return true;
  }
  return false;
};

const isHonoEnv = (node) => (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
  && memberName(node) === "env" && !isEnvObject(node);

export const scanEnvReads = (file, text) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const report = (kind, node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ kind, file, line: line + 1, text: node.getText(source) });
  };
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (isEnvObject(node.expression)) report("env-read", node);
      else if (isHonoEnv(node.expression) && !HONO_BINDINGS.has(memberName(node))) report("hono-binding", node);
      else if (isEnvObject(node) && memberName(node) === "env") report("env-read", node);
    } else if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)
      && (isEnvObject(node.initializer) || isHonoEnv(node.initializer))) {
      report("env-read", node);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "cloudflare:workers") {
      report("platform-import", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};
