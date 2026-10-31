// Reads the real CPU time of deployed requests from Workers observability (ADR 0027 pull
// request 1, #56). Workers Logs record one `cf-worker-event` per invocation with
// `$workers.cpuTimeMs`, `$workers.wallTimeMs` and `$workers.outcome` (`exceededCpu` when the
// platform stopped it), but they arrive some seconds to minutes after the request, so the reader
// polls with a bounded timeout and reports what it could not read instead of failing.
//
// Correlation, so no other traffic is mistaken for a probe:
//   Worker invocation   `cf-ray` request header of the invocation event = the response's `cf-ray`
//   Durable Object      `x-policysql-request-id` request header of the invocation event = the
//                       PolicySQL request id in the response (`meta.requestId`, `error.requestId`)
// The CPU of a request is the sum over its invocations: the Worker (authentication, body
// handling, forwarding) and the Durable Object (compile, step machine, Turso) each have their own
// `cpu_ms` budget, and the Node reference measurement (scripts/lib/cpu-bench.mjs) covers both.
//
// Needs `CLOUDFLARE_API_TOKEN` to read Workers Observability (the token that deploys the Worker
// in the dev environment already can) and `CLOUDFLARE_ACCOUNT_ID`.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The ray id of a `cf-ray` response header (`a52ec567785812bb-NRT` -> `a52ec567785812bb`). */
export const rayIdOf = (header) => (typeof header === "string" ? header.split("-")[0] : null);

/**
 * Invocation events of `service` between `from` and `to` (epoch ms), newest first. Throws an
 * error naming only the HTTP status (never the token) when the API refuses.
 */
export const queryInvocationEvents = async ({ accountId, token, service, from, to, limit = 1_000, fetchImpl = fetch }) => {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      queryId: "policysql-release-cpu",
      timeframe: { from, to },
      view: "events",
      limit,
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: service },
          { key: "$metadata.type", operation: "eq", type: "string", value: "cf-worker-event" },
        ],
        calculations: [],
        groupBys: [],
        orderBy: { value: "timestamp", order: "desc" },
      },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    throw Object.assign(new Error(`Workers observability query failed (HTTP ${response.status})`), { status: response.status });
  }
  return body?.result?.events?.events ?? [];
};

const invocation = (event) => ({
  eventType: event.$workers?.eventType ?? null,
  executionModel: event.$workers?.executionModel ?? null,
  outcome: event.$workers?.outcome ?? null,
  cpuTimeMs: event.$workers?.cpuTimeMs ?? null,
  wallTimeMs: event.$workers?.wallTimeMs ?? null,
  status: event.$workers?.event?.response?.status ?? null,
  scriptVersion: event.$workers?.scriptVersion?.id ?? null,
});

/**
 * The invocations of one probe found in `events`: `{ worker, owners }`. `probe` is
 * `{ rayId, requestId }`. Events of other requests (other rays and request ids) are ignored.
 */
export const invocationsOf = (events, probe) => {
  const header = (event, name) => event.$workers?.event?.request?.headers?.[name];
  const workerEvents = events.filter((event) => event.$workers?.executionModel === "stateless" && probe.rayId && header(event, "cf-ray") === probe.rayId);
  const ownerEvents = events.filter((event) => event.$workers?.executionModel === "durableObject" && probe.requestId && header(event, "x-policysql-request-id") === probe.requestId);
  return { worker: workerEvents.length ? invocation(workerEvents[0]) : null, owners: ownerEvents.map(invocation) };
};

/**
 * Summarizes a probe: the CPU of every invocation, their sum, and whether it is complete (the
 * Worker event is there, and a Durable Object event when the request used one).
 */
export const summarizeProbe = (probe, found) => {
  const all = [...(found.worker ? [found.worker] : []), ...found.owners];
  const complete = found.worker !== null && (!probe.usesOwner || found.owners.length > 0) && all.every((entry) => Number.isFinite(entry.cpuTimeMs));
  return {
    name: probe.name,
    complete,
    workerCpuMs: found.worker?.cpuTimeMs ?? null,
    ownerCpuMs: found.owners.length ? found.owners.reduce((sum, entry) => sum + (entry.cpuTimeMs ?? 0), 0) : null,
    cpuMs: complete ? all.reduce((sum, entry) => sum + entry.cpuTimeMs, 0) : null,
    wallMs: found.worker?.wallTimeMs ?? null,
    outcomes: [...new Set(all.map((entry) => entry.outcome))],
    invocations: all,
  };
};

/**
 * Polls until every probe is complete or `timeoutMs` passes. Never throws: a failing or
 * unauthorized query ends the polling with `unavailable` and its reason (a status, never a
 * secret). `probes` is `[{ name, rayId, requestId, usesOwner }]`; `since` is the epoch ms before
 * the first probe was sent. Returns `{ status: "read" | "partial" | "unavailable", reason?, probes, polls, elapsedMs }`.
 */
export const pollProbeCpu = async ({
  accountId, token, service, probes, since, timeoutMs = 150_000, intervalMs = 5_000,
  fetchImpl = fetch, now = Date.now, wait = sleep,
}) => {
  const started = now();
  let polls = 0;
  let summaries = probes.map((probe) => summarizeProbe(probe, { worker: null, owners: [] }));
  let reason = null;
  while (true) {
    polls += 1;
    try {
      const events = await queryInvocationEvents({ accountId, token, service, from: since - 60_000, to: now() + 60_000, fetchImpl });
      summaries = probes.map((probe) => summarizeProbe(probe, invocationsOf(events, probe)));
      reason = null;
    } catch (error) {
      reason = error?.message ?? "Workers observability query failed";
      // A refusal (401, 403, 400) will not change by waiting; only 429 and 5xx are worth another poll.
      if (error?.status >= 400 && error.status < 500 && error.status !== 429) break;
    }
    if (reason === null && summaries.every((summary) => summary.complete)) break;
    if (now() - started >= timeoutMs) break;
    await wait(intervalMs);
  }
  const complete = summaries.filter((summary) => summary.complete).length;
  const status = complete === probes.length ? "read" : complete > 0 ? "partial" : "unavailable";
  return {
    status, ...(status === "read" ? {} : { reason: reason ?? "invocation events were not ingested before the deadline" }),
    probes: summaries, polls, elapsedMs: now() - started,
  };
};
