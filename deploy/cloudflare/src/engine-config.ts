// The engine's deployment configuration (ADR 0019 `Config` port, ADR 0021).
//
// This is the only place that defines what a deployment configures. The wrapper reads its
// own sources (Workers `env`, a secret store, a file) and passes this object to `createApp`,
// `TransactionOwnerCore`, or the `deployment` function of `createPolicySqlWorker`. The
// library never reads a platform `env` object for any of these values.
//
// Validation runs once, at construction, before any database, Durable Object, or validator
// call. Errors are `TypeError`s that name the setting, never its value, so a secret cannot
// reach a log or a response through them.

/** Admission bounds for the cost observation, keyed by the catalog's numeric resource id. */
export type CostCatalog = {
  maxEstimatedRowsRead: number;
  maxEstimatedRowsWritten: number;
  resources: Record<string, { upperRows: number; [key: string]: unknown }>;
};

/** Where one commit check's validator lives and how its hook requests are signed. */
export type CommitCheckEndpoint = {
  /** `https:` URL without credentials. */
  url: string;
  /** HMAC-SHA256 key for `PolicySQL-Hook-Signature`, at least 16 characters. */
  hmacSecret: string;
};

export type PolicySqlConfig = {
  /** Deployment name reported by `/healthz` as `environment`. 1-64 of `[A-Za-z0-9_.:-]`. */
  environment: string;
  /**
   * Public `https:` origin that validators call back
   * (`<origin>/v1/commit-checks/<id>/query`). Required when `commitChecks` has an entry.
   */
  publicBaseUrl?: string;
  /**
   * Cost observation bounds. Without it, every cost observation is logged as
   * `cost_observation_failed` with `POLICYSQL_COST_UNKNOWN` and opens no database work.
   */
  costCatalog?: CostCatalog;
  /**
   * Validator endpoint per policy commit-check id. A triggered check without an entry
   * rejects the commit (409 `POLICYSQL_COMMIT_CHECK_REJECTED`); entries for ids the policy
   * does not define are never used.
   */
  commitChecks?: Record<string, CommitCheckEndpoint>;
};

/** The validated, frozen form the engine uses. Secrets are reachable only through `commitCheck`. */
export type ValidatedConfig = Readonly<{
  environment: string;
  publicBaseUrl: string | undefined;
  costCatalog: Readonly<CostCatalog> | undefined;
  commitCheck(id: string): Readonly<CommitCheckEndpoint> | undefined;
}>;

const KEYS = new Set(["environment", "publicBaseUrl", "costCatalog", "commitChecks"]);
const ENVIRONMENT = /^[A-Za-z0-9_.:-]{1,64}$/u;
// Policy commit-check ids are role-style identifiers (crates/policysql-policy).
const CHECK_ID = /^[a-z][a-z0-9_]*$/u;
const MIN_SECRET_LENGTH = 16;
const validated = new WeakSet<object>();

/**
 * A rejected `PolicySqlConfig`. `setting` names the offending setting (`config.<path>`);
 * neither it nor the message ever contains a configured value.
 */
export class ConfigError extends TypeError {
  readonly setting: string;
  constructor(setting: string, rule: string) {
    super(`${setting} ${rule}`);
    this.name = "ConfigError";
    this.setting = setting;
  }
}

const invalid = (path: string, rule: string) => new ConfigError(`config.${path}`, rule);

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const httpsUrl = (value: unknown, path: string, originOnly: boolean): string => {
  if (typeof value !== "string") throw invalid(path, "must be an https URL");
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(path, "must be an https URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw invalid(path, "must be an https URL without credentials");
  }
  if (originOnly && (url.pathname !== "/" || url.search !== "" || url.hash !== "")) {
    throw invalid(path, "must be an origin without path, query, or fragment");
  }
  return originOnly ? url.origin : url.toString();
};

const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

const costCatalog = (value: unknown): Readonly<CostCatalog> => {
  let copy: unknown;
  try { copy = structuredClone(value); } catch { throw invalid("costCatalog", "must be JSON data"); }
  if (!plainObject(copy)) throw invalid("costCatalog", "must be an object");
  if (!positiveInteger(copy.maxEstimatedRowsRead)) throw invalid("costCatalog.maxEstimatedRowsRead", "must be a positive integer");
  if (!positiveInteger(copy.maxEstimatedRowsWritten)) throw invalid("costCatalog.maxEstimatedRowsWritten", "must be a positive integer");
  if (!plainObject(copy.resources)) throw invalid("costCatalog.resources", "must be an object");
  for (const [id, resource] of Object.entries(copy.resources)) {
    if (!/^[1-9][0-9]{0,9}$/u.test(id)) throw invalid("costCatalog.resources", "keys must be catalog resource ids");
    if (!plainObject(resource) || !positiveInteger(resource.upperRows)) {
      throw invalid(`costCatalog.resources.${id}.upperRows`, "must be a positive integer");
    }
  }
  return deepFreeze(copy as CostCatalog);
};

const commitChecks = (value: unknown): Map<string, Readonly<CommitCheckEndpoint>> => {
  if (!plainObject(value)) throw invalid("commitChecks", "must be an object keyed by commit-check id");
  const entries = new Map<string, Readonly<CommitCheckEndpoint>>();
  for (const [id, endpoint] of Object.entries(value)) {
    if (!CHECK_ID.test(id)) throw invalid("commitChecks", "keys must be policy commit-check ids");
    if (!plainObject(endpoint) || Object.keys(endpoint).some((key) => key !== "url" && key !== "hmacSecret")) {
      throw invalid(`commitChecks.${id}`, "must be exactly { url, hmacSecret }");
    }
    const url = httpsUrl(endpoint.url, `commitChecks.${id}.url`, false);
    if (typeof endpoint.hmacSecret !== "string" || endpoint.hmacSecret.length < MIN_SECRET_LENGTH) {
      throw invalid(`commitChecks.${id}.hmacSecret`, `must be a string of at least ${MIN_SECRET_LENGTH} characters`);
    }
    entries.set(id, Object.freeze({ url, hmacSecret: endpoint.hmacSecret }));
  }
  return entries;
};

/**
 * Validates a wrapper-supplied `PolicySqlConfig` and returns the frozen form the engine
 * uses. Unknown keys are rejected so a misspelled setting cannot silently fall back.
 * Passing an already validated value returns it unchanged.
 */
export const validateConfig = (value: unknown): ValidatedConfig => {
  if (value !== null && typeof value === "object" && validated.has(value)) return value as ValidatedConfig;
  if (!plainObject(value)) throw new ConfigError("config", "is required and must be a PolicySqlConfig object");
  const unknown = Object.keys(value).find((key) => !KEYS.has(key));
  if (unknown !== undefined) throw new ConfigError(`config.${unknown}`, "is not a known setting");
  if (typeof value.environment !== "string" || !ENVIRONMENT.test(value.environment)) {
    throw invalid("environment", "must be 1-64 characters of [A-Za-z0-9_.:-]");
  }
  const publicBaseUrl = value.publicBaseUrl === undefined
    ? undefined : httpsUrl(value.publicBaseUrl, "publicBaseUrl", true);
  const catalog = value.costCatalog === undefined ? undefined : costCatalog(value.costCatalog);
  const checks = value.commitChecks === undefined ? new Map() : commitChecks(value.commitChecks);
  if (checks.size > 0 && publicBaseUrl === undefined) {
    throw invalid("publicBaseUrl", "is required when commitChecks has an entry");
  }
  const config: ValidatedConfig = Object.freeze({
    environment: value.environment,
    publicBaseUrl,
    costCatalog: catalog,
    // A function, so serializing or logging the config never prints a secret.
    commitCheck: (id: string) => checks.get(id),
  });
  validated.add(config);
  return config;
};
