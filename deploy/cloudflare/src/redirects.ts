// Outbound fetches from the Worker must not follow redirects: a redirect could move
// a bearer token or a signed hook body to a host the operator did not configure.
// workerd rejects the "error" redirect mode with a TypeError (it is not implemented
// at the edge), so callers pass `redirect: "manual"` and reject the redirect response
// themselves. With "manual", workerd returns the 3xx response itself; browsers and
// some runtimes return an `opaqueredirect` response with status 0 instead.
export const NO_FOLLOW = "manual" as const;

export const isRedirectResponse = (response: Response): boolean =>
  response.type === "opaqueredirect" || (response.status >= 300 && response.status <= 399);

// Release the connection without reading the body. The caller's failure is already
// terminal, so a cancellation error is not reported.
export const discardBody = async (response: Response): Promise<void> => {
  try { await response.body?.cancel(); } catch { /* the failure is already terminal */ }
};
