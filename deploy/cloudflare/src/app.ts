// The engine assembled with the HTTP inbound adapter (ADR 0019, ADR 0023). `createEngine`
// alone is the entry point for non-HTTP callers; `createApp` adds the canonical HTTP mapping.
import { createEngine } from "./engine.ts";
import type { PolicySqlEngine } from "./engine.ts";
import { createHttpAdapter } from "./http/adapter.ts";
import type { PolicySqlHttpApp } from "./http/adapter.ts";
import type { AppDependencies } from "./types.ts";

export type PolicySqlApp = PolicySqlHttpApp & {
  /** The same engine the HTTP adapter calls, for in-process or service-binding callers. */
  engine: PolicySqlEngine;
};

export const createApp = (input: AppDependencies): PolicySqlApp => {
  const engine = createEngine(input);
  const http = createHttpAdapter(engine);
  return { engine, fetch: http.fetch, fetchCallback: http.fetchCallback };
};
