// Waits until the release just deployed answers every request (#42).
//
// Right after `wrangler deploy`, Cloudflare still routes some requests to the previous Worker
// version, and a Durable Object may still run the previous code. A smoke started in that window
// fails for reasons that are not regressions (old signing keys -> 401, an older owner wire ->
// 503, old compiler behavior). The reference wrapper therefore reports the version that
// answered (`policysql-deployment-version` header, wrapper/deployment-version.ts) and, on the
// authenticated `GET /healthz/owner`, the version of a fresh Durable Object as well.
//
// `waitForRelease` requires `required` consecutive rounds in which
//   - `/healthz/owner` answers 200 with the header, `worker`, and `owner` all equal to the
//     version id `wrangler deploy` printed, and
//   - the dev validator Worker's `/healthz` carries its own new version id,
// then one Capabilities read of the release's snapshot, ABI version, limits and configured
// commit checks. Any other answer resets the count. The smoke then checks the header of every
// response it receives (`versionTracker`), so a straggler is reported as version skew, never
// as a functional failure.
export const DEPLOYMENT_VERSION_HEADER = "policysql-deployment-version";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Records the version of every response. `skewed` lists version ids other than `expected`
 * (a previous release still answering: retryable). `unversioned` lists responses without the
 * header with their status and path: they never reached the wrapper (a Cloudflare error page
 * such as 1101 or 52x), which is a failure of this release, not skew, and is not retried.
 */
export const versionTracker = (expected, fetchImpl = fetch) => {
  const seen = new Map();
  const unversioned = [];
  let rateLimited = 0;
  const call = async (url, init) => {
    const response = await fetchImpl(url, init);
    const version = response.headers.get(DEPLOYMENT_VERSION_HEADER);
    if (version === null) unversioned.push({ status: response.status, path: new URL(url).pathname });
    else seen.set(version, (seen.get(version) ?? 0) + 1);
    if (response.status === 429) rateLimited += 1;
    return response;
  };
  return {
    call,
    get responses() { return [...seen.values()].reduce((sum, count) => sum + count, unversioned.length); },
    get skewed() { return [...seen.entries()].filter(([version]) => version !== expected).map(([version, count]) => ({ version, count })); },
    get unversioned() { return [...unversioned]; },
    get rateLimited() { return rateLimited; },
    /** A failure is worth a rerun only when a previous version answered or the client limit hit. */
    get retryable() { return unversioned.length === 0 && (this.skewed.length > 0 || rateLimited > 0); },
  };
};

/**
 * Resolves `{ rounds, staleAnswers, elapsedMs }` once the release answers `required`
 * consecutive rounds; rejects at `timeoutMs`. `capabilitiesMatch(body)` judges the final
 * Capabilities read. `validator` is `{ url, version }` or undefined.
 */
export const waitForRelease = async ({
  baseUrl, token, version, validator, capabilitiesMatch,
  required = 5, intervalMs = 1_000, timeoutMs = 180_000, fetchImpl = fetch, now = Date.now, wait = sleep,
}) => {
  const started = now();
  let consecutive = 0;
  let rounds = 0;
  let staleAnswers = 0;
  const last = {};
  while (now() - started < timeoutMs) {
    rounds += 1;
    let fresh = false;
    try {
      const owner = await fetchImpl(`${baseUrl}/healthz/owner?release=${now()}`, { headers: { authorization: `Bearer ${token}` } });
      const body = owner.ok ? await owner.json() : (await owner.body?.cancel(), null);
      last.owner = { status: owner.status, header: owner.headers.get(DEPLOYMENT_VERSION_HEADER), body };
      fresh = owner.ok && last.owner.header === version && body?.worker === version && body?.owner === version;
      if (fresh && validator) {
        const health = await fetchImpl(`${validator.url}/healthz?release=${now()}`);
        await health.body?.cancel();
        last.validator = { status: health.status, header: health.headers.get(DEPLOYMENT_VERSION_HEADER) };
        fresh = health.ok && last.validator.header === validator.version;
      }
    } catch (error) {
      last.error = error?.name ?? "Error";
      fresh = false;
    }
    if (!fresh) staleAnswers += 1;
    consecutive = fresh ? consecutive + 1 : 0;
    if (consecutive >= required) {
      const response = await fetchImpl(`${baseUrl}/v1/capabilities?release=${now()}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json().catch(() => null);
      if (response.ok && response.headers.get(DEPLOYMENT_VERSION_HEADER) === version && capabilitiesMatch(body)) {
        return { rounds, staleAnswers, required, elapsedMs: now() - started };
      }
      last.capabilities = {
        status: response.status, header: response.headers.get(DEPLOYMENT_VERSION_HEADER), id: body?.id ?? null,
        abiVersion: body?.abiVersion ?? null, commitChecksConfigured: body?.transactions?.commitChecksConfigured ?? null,
      };
      consecutive = 0;
    }
    await wait(intervalMs);
  }
  throw new Error(`the deployed release did not answer ${required} consecutive rounds before the deadline: ${JSON.stringify(last)}`);
};
