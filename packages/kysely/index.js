import { SqliteQueryCompiler, createQueryId } from "kysely";

const bindings = new WeakMap();
const proxies = new WeakMap();

class PolicySqliteQueryCompiler extends SqliteQueryCompiler {
  getCurrentParameterPlaceholder() {
    return `:p${this.numParameters}`;
  }
}

const compiler = new PolicySqliteQueryCompiler();

const operationFromNode = (node) => {
  switch (node?.kind) {
    case "SelectQueryNode": return "select";
    case "InsertQueryNode": return "insert";
    case "UpdateQueryNode": return "update";
    case "DeleteQueryNode": return "delete";
    default: throw new TypeError("unsupported Kysely query operation");
  }
};

export const compilePolicyQuery = (query) => {
  if (typeof query?.toOperationNode === "function") {
    const node = query.toOperationNode();
    const compiled = compiler.compileQuery(node, createQueryId());
    return {
      operation: operationFromNode(node),
      sql: compiled.sql,
      params: Object.fromEntries(compiled.parameters.map((value, index) => [`p${index + 1}`, value])),
    };
  }

  // A precompiled query has already discarded the boundary between SQL syntax and string
  // literals/comments. It is safe only when there are no positional values to rewrite.
  const compiled = query?.compile?.();
  if (!compiled) throw new TypeError("query must expose Kysely toOperationNode()");
  const parameters = compiled.parameters ?? [];
  if (parameters.length !== 0) {
    throw new TypeError("parameterized queries must expose Kysely toOperationNode()");
  }
  return { operation: "select", sql: compiled.sql, params: {} };
};

const randomIdempotencyKey = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw new TypeError("mutation execution requires an idempotencyKey when crypto.randomUUID is unavailable");
};

const executeQuery = async (query, binding, options = {}) => {
  const request = compilePolicyQuery(query);
  const executeOptions = {
    ...(request.operation === "select"
      ? {}
      : { idempotencyKey: options.idempotencyKey ?? randomIdempotencyKey() }),
    ...(options.expect ? { expect: options.expect } : {}),
  };
  binding.onQuery?.(request);
  try {
    const result = await binding.client.execute(request.sql, request.params, executeOptions);
    binding.onResult?.({ request, result });
    return result;
  } catch (error) {
    binding.onError?.({ request, error });
    throw error;
  }
};

const policyExecution = (query, binding, options = {}) => ({
  async execute() {
    return (await executeQuery(query, binding, options)).rows;
  },
  async executeTakeFirst() {
    return (await executeQuery(query, binding, options)).rows[0];
  },
  async executeTakeFirstOrThrow() {
    const row = (await executeQuery(query, binding, options)).rows[0];
    if (row === undefined) throw new Error("PolicySQL query returned no result");
    return row;
  },
  async executeWithPolicyMeta() {
    return await executeQuery(query, binding, options);
  },
});

const wrap = (value, binding) => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  const existing = proxies.get(value);
  if (existing) return existing;
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      if (typeof target.toOperationNode === "function") {
        const execution = policyExecution(target, binding);
        if (property === "execute") return execution.execute;
        if (property === "executeTakeFirst") return execution.executeTakeFirst;
        if (property === "executeTakeFirstOrThrow") return execution.executeTakeFirstOrThrow;
        if (property === "executeWithPolicyMeta") return execution.executeWithPolicyMeta;
      }
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      return (...args) => wrap(Reflect.apply(member, target, args), binding);
    },
  });
  bindings.set(proxy, binding);
  proxies.set(value, proxy);
  return proxy;
};

export const bindPolicyKysely = (kysely, clientOrOptions) => {
  const binding = clientOrOptions?.client
    ? clientOrOptions
    : { client: clientOrOptions };
  if (!binding.client?.execute) throw new TypeError("PolicySQL client is required");
  return wrap(kysely, binding);
};

const resolveBinding = (query, explicitClient) => {
  if (explicitClient) return { client: explicitClient };
  const binding = bindings.get(query);
  if (!binding) throw new TypeError("PolicySQL client is not bound");
  return binding;
};

export const policyQuery = (query, options = {}, explicitClient) => {
  // Compile eagerly so unsupported/precompiled parameterized queries fail before execution.
  compilePolicyQuery(query);
  return policyExecution(query, resolveBinding(query, explicitClient), options);
};

export const policySelect = (query, _resource, _conditionalColumns = [], explicitClient) => {
  const execution = policyQuery(query, {}, explicitClient);
  return {
    execute: execution.execute,
    executeTakeFirst: execution.executeTakeFirst,
    executeTakeFirstOrThrow: execution.executeTakeFirstOrThrow,
    executeWithPolicyMeta: execution.executeWithPolicyMeta,
  };
};

export const policyMutation = (query, options = {}, explicitClient) => {
  const compiled = compilePolicyQuery(query);
  if (compiled.operation === "select") throw new TypeError("policyMutation requires a mutation query");
  return policyExecution(query, resolveBinding(query, explicitClient), options);
};

export const createPolicyKysely = ({ kysely, client, onQuery, onResult, onError }) =>
  bindPolicyKysely(kysely, { client, onQuery, onResult, onError });
