import ts from "typescript";

// Structural guard for platform-environment use in library source (#32, ADR 0021). It
// parses each file and inspects syntax nodes, so comments and string contents never match.
//
// It is a positive allowlist, not a list of forbidden spellings. Every reference to an
// identifier named `env` or `deployment` must be one of:
//
// - a parameter declaration (including a binding element of a destructured parameter);
// - an argument passed directly to a known sink: the wrapper's `deployment(env)`, the
//   library's own `build(env)`, `appFor(env)`, `platformTransactionOwner(env)`, the app's
//   `.fetch(request, env, ...)` / `.fetchCallback(request, env, ...)` (second argument
//   only), or the env-keyed cache
//   `apps.get(env)` / `apps.set(env, app)`;
// - a presence check that reads nothing: `typeof env`, `env === null` / `undefined`;
// - the callee of `deployment(env)` (calling the wrapper's function);
// - the object of `env.TRANSACTION_OWNER`, reported as an "env-read" finding so the test can
//   assert that it is the single documented exception (#31).
//
// Anything else is a finding ("env-reference"): aliasing (`const e = env`), spreading
// (`{ ...env }`), `Reflect.get(env, ...)`, `Object.entries(env)`, `JSON.stringify(env)`,
// casts (`(env as any).X`), shorthand properties (`{ env }`), passing env to any other
// function, declaring a variable or import named env, and any member read.
//
// Member names `env` (`<expr>.env`) are separate: the library's Hono context exposes the
// bindings `app.fetch` builds itself as `context.env`. `<expr>.env` must be followed by
// one of HONO_BINDINGS ("hono-binding" otherwise), and `this.env` / `process.env` are always
// findings. An import from `cloudflare:workers` (the platform env as a module export) is a
// "platform-import" finding.
const NAMES = new Set(["env", "deployment"]);
export const HONO_BINDINGS = new Set(["transactionOwner", "databaseBinding", "session", "requestId", "callback"]);
const SINK_FUNCTIONS = new Set(["deployment", "build", "appFor", "platformTransactionOwner"]);
const SINK_METHODS = new Set(["fetch", "fetchCallback"]);
const CACHE_METHODS = { apps: new Set(["get", "set"]) };

const inTypeContext = (node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
  }
  return false;
};

const literalText = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const memberName = (node) => ts.isPropertyAccessExpression(node) ? node.name.text : literalText(node.argumentExpression);

// A slot that names a property or member rather than referring to a binding.
const isNameSlot = (node) => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)
    || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessor(parent)
    || ts.isSetAccessor(parent)) && parent.name === node) return true;
  return false;
};

const inParameter = (node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isParameter(current)) return true;
    if (!ts.isBindingElement(current) && !ts.isObjectBindingPattern(current) && !ts.isArrayBindingPattern(current)) return false;
  }
  return false;
};

const isSinkCallee = (callee) => {
  if (ts.isIdentifier(callee)) return SINK_FUNCTIONS.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    if (SINK_METHODS.has(callee.name.text)) return true;
    return ts.isIdentifier(callee.expression)
      && CACHE_METHODS[callee.expression.text]?.has(callee.name.text) === true;
  }
  return false;
};

const isNullish = (node) => node.kind === ts.SyntaxKind.NullKeyword
  || (ts.isIdentifier(node) && node.text === "undefined");

// Is this `env` / `deployment` reference one the allowlist permits?
const allowedReference = (node) => {
  const parent = node.parent;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node && !parent.propertyName && inParameter(parent)) return true;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node)) {
    // `.fetch` / `.fetchCallback` take the platform bindings as their second argument only.
    if (ts.isPropertyAccessExpression(parent.expression) && SINK_METHODS.has(parent.expression.name.text)) {
      return parent.arguments[1] === node;
    }
    return isSinkCallee(parent.expression);
  }
  if (ts.isCallExpression(parent) && parent.expression === node) return node.text === "deployment";
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isBinaryExpression(parent)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)) {
    return isNullish(parent.left === node ? parent.right : parent.left);
  }
  return false;
};

export const scanEnvReads = (file, text) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const report = (kind, node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ kind, file, line: line + 1, text: node.getText(source) });
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && NAMES.has(node.text) && !inTypeContext(node)) {
      const parent = node.parent;
      if (ts.isBindingElement(parent) && parent.propertyName === node) {
        // `{ env: alias }` destructures a member named env from some object.
        if (!inParameter(parent)) report("env-reference", parent);
      } else if (isNameSlot(node)) {
        // Member names are handled below.
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node
        && node.text === "env" && parent.name.text === "TRANSACTION_OWNER") {
        report("env-read", parent);
      } else if (!allowedReference(node)) {
        report("env-reference", node);
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberName(node) === "env") {
      const base = node.expression;
      const parent = node.parent;
      if (base.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(base) && base.text === "process")) {
        report("env-reference", node);
      } else if (!((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === node && HONO_BINDINGS.has(memberName(parent)))) {
        report("hono-binding", (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node ? parent : node);
      }
    }
    if (ts.isImportDeclaration(node) && literalText(node.moduleSpecifier) === "cloudflare:workers") {
      report("platform-import", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};
