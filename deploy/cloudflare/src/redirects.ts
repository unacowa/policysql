// The only outbound HTTP exit for Worker code (#36). Callers classify failures; this
// module owns the redirect rule so no caller can read a redirect body by mistake.
//
// Outbound fetches must not follow redirects: a redirect could move a bearer token or
// a signed hook body to a host the operator did not configure. workerd rejects the
// "error" redirect mode with a TypeError (it is not implemented at the edge), so this
// module forces "manual" and rejects the redirect response itself. With "manual",
// workerd returns the 3xx response itself; browsers and some runtimes return an
// `opaqueredirect` response with status 0 instead.
//
// test/worker-fetch-redirect.test.mjs enforces that this is the only Worker source
// file that sets the redirect mode or calls the global fetch.

export type OutboundFetch = (input: string | URL, init: RequestInit) => Promise<Response>;
export type NoFollowInit = Omit<RequestInit, "redirect">;

/** Thrown after the redirect body was discarded; callers map it to their own error. */
export class RedirectRejectedError extends Error {
  constructor() {
    super("Outbound redirect rejected.");
    this.name = "RedirectRejectedError";
  }
}

const isRedirectResponse = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status <= 399);

// Release a response without reading it. The caller's failure is already terminal,
// so a cancellation error is not reported.
export const discardBody = async (response: Response): Promise<void> => {
  try { await response.body?.cancel(); } catch { /* the failure is already terminal */ }
};

// Cloudflare requires the host fetch receiver, so the default calls through globalThis.
const hostFetch: OutboundFetch = (input, init) => globalThis.fetch(input, init);

/**
 * Fetch once without following redirects. A 3xx or `opaqueredirect` response is
 * discarded unread and rejected with RedirectRejectedError; any other response is
 * returned to the caller. Network, timeout and abort errors propagate unchanged.
 */
export const fetchNoFollow = async (
  input: string | URL,
  init: NoFollowInit,
  fetchImpl: OutboundFetch = hostFetch,
): Promise<Response> => {
  const response = await fetchImpl(input, { ...init, redirect: "manual" });
  if (isRedirectResponse(response)) {
    await discardBody(response);
    throw new RedirectRejectedError();
  }
  return response;
};
