// ADR 0025, "What happens at the deployment that switches the rule": retries that straddle
// the deployment from ABI 4 (byte equality with `stableJson`) to ABI 5 (core-defined canonical
// JSON), and on to the current ABI (which keeps ADR 0025's stability requirements). The rows
// and keys below hold the values the ABI 4 implementation computed, by a frozen copy of it.
// Interactive records of ABI 4 were written by the TypeScript owner; since ADR 0024 pull
// request 7 they are discarded, not read (the one-time incompatibility), so only their commit
// answer (unknown, never a rejection) is pinned here. The step machine's own records keep the
// stability requirements: the control test shows what a changed digest would do.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness, OWNER_ADAPTERS } from "./helpers/routing.mjs";

// `stableJson` and `sha256` from deploy/cloudflare/src/idempotency.ts on main before ADR 0025
// (f56b574), copied verbatim: the implementation that wrote every stored value of ABI 4.
const legacyStableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(legacyStableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${legacyStableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const legacySha256 = async (value) => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const legacyAuthFingerprint = ({ principal, subject, role, session }, databaseBinding) =>
  legacySha256(legacyStableJson({ principal, subject, role, session, databaseBinding }));
const legacyCommandDigest = (kind, command) => legacySha256(legacyStableJson({ kind, command }));
const legacyKeyHash = ({ principal, subject, role, session }, endpoint, binding, key) => legacySha256(`${legacyStableJson({
  principal, subject, role, session, endpoint, database: { scope: binding.scope, databaseId: binding.databaseId },
})}:${key}`);

const { goldens } = JSON.parse(readFileSync(new URL("../../../tests/fixtures/identity-goldens.json", import.meta.url), "utf8"));

test("the frozen ABI 4 implementation computes the identity goldens", async () => {
  for (const { name, input, output } of goldens) {
    if (input.op === "auth") assert.equal(await legacyAuthFingerprint(input.auth, input.binding), output.fingerprint, name);
    if (input.op === "command") assert.equal(await legacyCommandDigest(input.kind, input.command), output.digest, name);
    if (input.op === "request") {
      assert.equal(await legacyKeyHash(input.auth, input.endpoint, input.binding, input.key), output.idempotency.keyHash, name);
    }
  }
});

// A caller whose identity has non-ASCII characters and characters `JSON.stringify` escapes.
const SUBJECT = "josé_山田_\u{1f600}_\"\\\u001f\u007f ";
const UNKNOWN = "POLICYSQL_COMMIT_OUTCOME_UNKNOWN";
const insert = (id) => ({ sql: "INSERT INTO projects (id, name) VALUES (:id, :name) RETURNING id, name", params: { id, name: id } });

for (const ownerAdapter of OWNER_ADAPTERS) {
  const setup = async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: false });
    const real = h.runtime.snapshot;
    // This code is ABI 5 or later; the previous releases' snapshots differed only in their ABI
    // suffix.
    const current = h.runtime.abi_version;
    assert.ok(current >= 5);
    assert.match(real, new RegExp(`:abi-${current}$`, "u"));
    const at = (abi) => {
      if (abi === current) delete h.runtime.snapshot;
      else Object.defineProperty(h.runtime, "snapshot", { value: real.replace(/:abi-\d+$/u, `:abi-${abi}`), configurable: true });
      assert.match(h.runtime.snapshot, new RegExp(`:abi-${abi}$`, "u"));
    };
    const credential = h.session("a", { principal: `https://issuer.test:${SUBJECT}`, subject: SUBJECT, session: { tenant_id: "tenant_a" } });
    const send = (path, body, key = null) => h.request("a", path, body, key, credential);
    return { h, at: (abi) => at(abi === "current" ? current : abi), send, credential };
  };

  const openWrite = async (send, label) => {
    const begun = await send("/v1/transactions", { mode: "write" });
    assert.equal(begun.status, 201, JSON.stringify(begun.body));
    const id = begun.body.transactionId;
    const statement = await send(`/v1/transactions/${id}/statements`, { sequence: 1, ...insert(label) });
    assert.equal(statement.status, 200, JSON.stringify(statement.body));
    return { id, commit: () => send(`/v1/transactions/${id}/commit`, { sequence: 2 }) };
  };

  const committedOnce = (h, id) => assert.equal(h.rows("a").filter((row) => row.id === id).length, 1, id);

  // A record the ABI 4 owner wrote, computed with the frozen ABI 4 rules. Since ADR 0024 pull
  // request 7 every record of the TypeScript owner, ABI 4's included, is discarded, not read:
  // a commit retry is unknown (never a rejection), anything else unavailable. That is the
  // one-time incompatibility of the switch-over; ADR 0007 holds across it.
  const abi4Record = async (h, id, credential, status) => {
    const binding = { ...h.binding("a"), snapshot: h.runtime.snapshot.replace(/:abi-\d+$/u, ":abi-4") };
    const auth = { principal: credential.principal, subject: credential.subject, role: credential.defaultRole, roles: credential.roles, access: credential.access, session: credential.session };
    const commitDigest = await legacyCommandDigest("commit", { sequence: 2 });
    const reply = { transactionId: id, status: "committed", meta: { requestId: "abi4", commitChecks: "not_triggered" } };
    return {
      databaseBinding: binding, snapshot: binding.snapshot, transactionId: id,
      authFingerprint: await legacyAuthFingerprint(auth, binding), startFingerprint: "c".repeat(64), mode: "write", auth,
      status, commitRecording: 1, commitSent: { sequence: 2, digest: commitDigest },
      nextSequence: status === "committed" ? 3 : 2,
      ...(status === "committed" ? { last: { digest: commitDigest, response: reply } } : { expiresAtMs: Date.now() + 60_000 }),
      usage: { rowsRead: 0, rowsWritten: 0, queryDurationMs: 0 }, statementCount: 1, resultBytes: 10,
      mutations: [], commitChecks: [], schemaVersion: "schema_routing_1", policyVersion: "policy_routing_1",
    };
  };

  for (const status of ["committed", "committing"]) {
    test(`${ownerAdapter}: a ${status} record written by ABI 4 is discarded: the commit retry is unknown, never rejected`, async (t) => {
      const { h, send, credential } = await setup(t);
      const id = `tx_${(status === "committed" ? "4" : "5").repeat(32)}`;
      h.plantOwnerRecord(id, await abi4Record(h, id, credential, status));
      for (const attempt of [1, 2]) {
        const retry = await send(`/v1/transactions/${id}/commit`, { sequence: 2 });
        assert.equal(retry.status, 503, `${attempt}: ${JSON.stringify(retry.body)}`);
        assert.equal(retry.body.error.code, UNKNOWN);
      }
      const statement = await send(`/v1/transactions/${id}/statements`, { sequence: 2, ...insert("abi_never") });
      assert.equal(statement.status, 409);
      assert.equal(statement.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE");
      assert.equal((await h.ownerRecord(id)).status, "discarded");
      assert.equal(h.rows("a").some((row) => row.id === "abi_never"), false);
    });
  }

  test(`${ownerAdapter}: control: a stored digest or replay identity the rule does not reproduce would be a definite rejection`, async (t) => {
    // Why ADR 0025's stability requirements hold for the step machine's records too: a
    // commit retry after a deployment (another snapshot) is answered from `last` only when the
    // replay identity and the digest match; otherwise it is the 409 that ADR 0007 forbids
    // after COMMIT.
    const { h, at, send } = await setup(t);
    for (const field of ["replay", "digest"]) {
      at("current");
      const { id, commit } = await openWrite(send, `abi_control_${field}`);
      const first = await commit();
      assert.equal(first.status, 200);
      at(4);
      assert.deepEqual((await commit()).body, first.body, `${field}: the untampered record replays across the deployment`);
      const record = JSON.parse(await h.ownerRecordRaw(id));
      if (field === "replay") record.identity.replay = "0".repeat(64);
      else record.last.digest = "0".repeat(64);
      h.ownerCore(id).loaded = false;
      h.plantOwnerRecord(id, JSON.stringify(record));
      const retry = await commit();
      assert.equal(retry.status, 409, `${field}: ${JSON.stringify(retry.body)}`);
      assert.equal(retry.body.error.code, "POLICYSQL_TRANSACTION_UNAVAILABLE", field);
    }
  });

  test(`${ownerAdapter}: a keyed atomic retry across the bump finds its ABI 4 row and conflicts; it never executes twice`, async (t) => {
    const { h, at, send, credential } = await setup(t);
    const key = "abi-bump-key-000001";
    const body = { statements: [insert("abi_keyed")] };
    at(4);
    const first = await send("/v1/transactions:execute", body, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // The row's key hash is the one ABI 4 computed.
    const auth = { principal: credential.principal, subject: credential.subject, role: credential.defaultRole, session: credential.session };
    const keyHash = await legacyKeyHash(auth, "execute", h.binding("a"), key);
    const rows = h.databases.get("a").database.prepare("SELECT key_hash FROM policysql_idempotency").all();
    assert.deepEqual(rows.map((row) => row.key_hash), [keyHash]);
    // Under the same snapshot the retry replays.
    const replay = await send("/v1/transactions:execute", body, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    at("current");
    const retry = await send("/v1/transactions:execute", body, key);
    // The same key hash finds the row; its fingerprint includes the old snapshot.
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error.code, "POLICYSQL_IDEMPOTENCY_CONFLICT");
    committedOnce(h, "abi_keyed");
    assert.equal(h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, 1);
  });

  test(`${ownerAdapter}: a keyed begin retry across a deployment reaches the same owner and conflicts`, async (t) => {
    const { h, at, send, credential } = await setup(t);
    const key = "abi-bump-begin-0001";
    at("current");
    const first = await send("/v1/transactions", { mode: "write" }, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    // The key hash has no snapshot: the transaction id is the one ABI 4 computed.
    const auth = { principal: credential.principal, subject: credential.subject, role: credential.defaultRole, session: credential.session };
    const keyHash = await legacyKeyHash(auth, "interactive-start", h.binding("a"), key);
    assert.equal(first.body.transactionId, `tx_${keyHash.slice(0, 32)}`, "the ABI 4 transaction id");
    at(4);
    const retry = await send("/v1/transactions", { mode: "write" }, key);
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error.code, "POLICYSQL_TRANSACTION_CONFLICT");
    assert.deepEqual(h.ownerNames(), [first.body.transactionId], "no second owner");
  });
}
