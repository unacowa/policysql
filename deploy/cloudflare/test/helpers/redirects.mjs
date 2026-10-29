// Fake redirect responses for outbound fetch tests. workerd returns the 3xx response
// itself under `redirect: "manual"`; other runtimes return an `opaqueredirect`
// response with status 0. Reading the body fails the test; `cancelled` records release.
export const redirectResponses = () => [
  { label: "302", type: "basic", status: 302, headers: { location: "https://attacker.example.test/" } },
  { label: "307", type: "basic", status: 307, headers: { location: "https://attacker.example.test/" } },
  { label: "308", type: "basic", status: 308, headers: { location: "https://attacker.example.test/" } },
  { label: "300", type: "basic", status: 300, headers: {} },
  { label: "399", type: "basic", status: 399, headers: {} },
  { label: "opaqueredirect", type: "opaqueredirect", status: 0, headers: {} },
].map(({ label, type, status, headers }) => {
  const state = { cancelled: false, read: false };
  const fail = () => { state.read = true; throw new Error(`redirect body read (${label})`); };
  const response = {
    type,
    status,
    ok: false,
    redirected: false,
    headers: new Headers(headers),
    body: { cancel: async () => { state.cancelled = true; } },
    get bodyUsed() { return state.read; },
    json: async () => fail(),
    text: async () => fail(),
    arrayBuffer: async () => fail(),
  };
  return { label, response, state };
});
