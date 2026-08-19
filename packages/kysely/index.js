import { SqliteQueryCompiler, createQueryId } from "kysely";

const bindings = new WeakMap();
const proxies = new WeakMap();

const wrap = (value, client) => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  const existing = proxies.get(value);
  if (existing) return existing;
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      return (...args) => wrap(Reflect.apply(member, target, args), client);
    },
  });
  bindings.set(proxy, client);
  proxies.set(value, proxy);
  return proxy;
};

export const bindPolicyKysely = (kysely, client) => {
  return wrap(kysely, client);
};

class PolicySqliteQueryCompiler extends SqliteQueryCompiler {
  getCurrentParameterPlaceholder() {
    return `:p${this.numParameters}`;
  }
}

const compiler = new PolicySqliteQueryCompiler();

const compileNamed = (query) => {
  if (typeof query.toOperationNode === "function") {
    const compiled = compiler.compileQuery(query.toOperationNode(), createQueryId());
    return {
      sql: compiled.sql,
      params: Object.fromEntries(compiled.parameters.map((value, index) => [`p${index + 1}`, value])),
    };
  }

  // A precompiled query has already discarded the boundary between SQL syntax and string
  // literals/comments. It is safe only when there are no positional values to rewrite.
  const compiled = query.compile();
  const parameters = compiled.parameters ?? [];
  if (parameters.length !== 0) {
    throw new TypeError("parameterized queries must expose Kysely toOperationNode()");
  }
  return { sql: compiled.sql, params: {} };
};

export const policySelect = (query, _resource, _conditionalColumns = [], explicitClient) => {
  const client = explicitClient ?? bindings.get(query);
  if (!client) throw new TypeError("PolicySQL client is not bound");
  const request = compileNamed(query);
  return {
    async execute() { return (await client.execute(request.sql, request.params)).rows; },
    async executeWithPolicyMeta() { return await client.execute(request.sql, request.params); },
  };
};

export const createPolicyKysely = ({ kysely, client }) => bindPolicyKysely(kysely, client);
