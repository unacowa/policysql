// ADR 0025, "What happens at the deployment that switches the rule": retries that straddle
// the deployment from ABI 4 (byte equality with `stableJson`) to ABI 5 (core-defined canonical
// JSON), and on to the current ABI (which keeps ADR 0025's stability requirements). The rows
// and keys below hold the values the ABI 4 implementation computed, by a frozen copy of it.
// Interactive records of ABI 4 were written by the TypeScript owner; since ADR 0024 pull
// request 7 they are discarded, not read (the one-time incompatibility), so only their commit
// answer (unknown, never a rejection) is pinned here. The step machine's own records keep the
// stability requirements: the control test shows what a changed digest would do.
// #80 (ABI 9) removed the binding's snapshot from the request fingerprint: keyed atomic writes
// retried across a real snapshot change (`h.redeploy`) replay on both placements and owner
// adapters, while rows stored before #80 (the ABI 4 row below) still conflict.
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
const legacyIdentity = ({ principal, subject, role, session }, endpoint, binding) => legacyStableJson({
  principal, subject, role, session, endpoint, database: { scope: binding.scope, databaseId: binding.databaseId },
});
const legacyKeyHash = (auth, endpoint, binding, key) => legacySha256(`${legacyIdentity(auth, endpoint, binding)}:${key}`);
const legacyFingerprint = (auth, endpoint, binding, body) =>
  legacySha256(`${legacyIdentity(auth, endpoint, binding)}:${legacyStableJson(body)}:${legacyStableJson(binding)}`);

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

  // The row the ABI 4 direct path wrote, with the values the frozen ABI 4 rules computed. Since
  // ADR 0024 pull request 8 the snapshot check of an execute is core's (the step machine reads
  // the runtime's own snapshot), so the earlier release's row is planted rather than written by
  // a runtime whose snapshot is faked. Its fingerprint has the binding's snapshot, which the
  // request fingerprint no longer has since #80 (ABI 9): every row stored before #80 conflicts
  // (the one-time incompatibility of that switch, ADR 0014), and never executes twice.
  test(`${ownerAdapter}: a keyed atomic retry across the bump finds its ABI 4 row and conflicts; it never executes twice`, async (t) => {
    const { h, send, credential } = await setup(t);
    const key = "abi-bump-key-000001";
    const body = { statements: [insert("abi_keyed")] };
    const auth = { principal: credential.principal, subject: credential.subject, role: credential.defaultRole, session: credential.session };
    const abi4 = { ...h.binding("a"), snapshot: h.runtime.snapshot.replace(/:abi-\d+$/u, ":abi-4") };
    const keyHash = await legacyKeyHash(auth, "execute", abi4, key);
    const fingerprint = await legacyFingerprint(auth, "execute", abi4, body);
    const database = h.databases.get("a").database;
    database.prepare("INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (?, ?, ?)").run(keyHash, fingerprint, JSON.stringify({
      version: 1, results: [{ columns: ["id", "name"], rows: [{ id: "abi_keyed", name: "abi_keyed" }], rowCount: 1, affectedRows: 1 }],
      usage: { rowsReturned: 1, rowsAffected: 1, rowsRead: 1, rowsWritten: 1, queryDurationMs: 0 },
      originalRequestId: "abi4", transactionId: `atomic_${keyHash.slice(0, 24)}`, replayed: false,
    }));
    const retry = await send("/v1/transactions:execute", body, key);
    // The same key hash (it has no snapshot) finds the row; its fingerprint has the old snapshot.
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error.code, "POLICYSQL_IDEMPOTENCY_CONFLICT");
    assert.equal(h.rows("a").some((row) => row.id === "abi_keyed"), false, "nothing executed");
    assert.equal(database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, 1);
    // Control: an old-format fingerprint is not this release's, even under the current
    // snapshot; this release's is the same construction over the binding without its snapshot.
    const sameSnapshot = await legacyFingerprint(auth, "execute", h.binding("a"), body);
    const current = JSON.parse(h.runtime.identity_json(JSON.stringify({
      op: "request", endpoint: "execute", auth: { ...auth, roles: credential.roles, access: credential.access },
      binding: h.binding("a"), body: JSON.stringify(body), key,
    }))).idempotency;
    assert.equal(current.keyHash, keyHash, "the key hash is unchanged");
    assert.notEqual(current.fingerprint, sameSnapshot);
    const { snapshot: _snapshot, ...withoutSnapshot } = h.binding("a");
    assert.equal(current.fingerprint, await legacySha256(`${legacyIdentity(auth, "execute", h.binding("a"))}:${legacyStableJson(body)}:${legacyStableJson(withoutSnapshot)}`),
      "the ABI 4 construction over the binding without its snapshot (#80)");
    // The same row under this release's fingerprint replays.
    database.prepare("UPDATE policysql_idempotency SET fingerprint = ?").run(current.fingerprint);
    const replay = await send("/v1/transactions:execute", body, key);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.meta.requestId, "abi4");
    assert.equal(h.rows("a").some((row) => row.id === "abi_keyed"), false, "a replay executes nothing");
  });

  // #80: a keyed atomic write committed before a deployment that changes the snapshot (here
  // another policy version, as an ABI bump or a schema change would) is retried after it. The
  // request fingerprint has no snapshot, so the retry replays the committed response instead of
  // the IDEMPOTENCY_CONFLICT a client takes as a definite rejection (ADR 0007). Another body or
  // another generation on the same key still conflicts. On both placements: direct (no commit
  // check triggers) and owner (a commit check triggers, so the engine forwards to the owner).
  for (const [placement, hooks] of [["direct", false], ["owner", true]]) {
    test(`${ownerAdapter}: #80: a committed keyed write (${placement}) retried across a snapshot change replays; another body or generation conflicts`, async (t) => {
      t.mock.method(console, "log", () => {});
      let generation = "1";
      const h = await harness(t, {
        ownerAdapter, hooks,
        customizeBinding: (binding) => ({ ...binding, generation }),
        customizeProvider: (provider) => ({
          check: (binding) => provider.check({ ...binding, generation: "1" }),
          connect: (binding, ...args) => provider.connect({ ...binding, generation: "1" }, ...args),
        }),
      });
      h.setValidator(async () => true);
      const key = "snapshot-change-key-0001";
      const body = { statements: [insert("across_snapshot")] };
      const commits = () => h.events.filter(({ sql }) => sql === "COMMIT").length;
      const first = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.meta.commitChecks, hooks ? "passed" : "not_triggered", "the placement");
      assert.equal(h.ownerNames().length, hooks ? 1 : 0, "the placement");
      const before = h.runtime.snapshot;
      const committed = commits();
      const hooksBefore = h.hooksSeen.length;

      const later = h.redeploy({ policyVersion: "policy_routing_2" });
      assert.notEqual(later.snapshot, before, "the deployment changed the snapshot");
      assert.equal(h.binding("a").snapshot, later.snapshot);
      const retry = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.deepEqual(retry.body.results, first.body.results, "the committed results");
      assert.equal(retry.body.transactionId, first.body.transactionId);
      assert.equal(retry.body.status, "committed");
      assert.equal(retry.body.meta.requestId, first.body.meta.requestId, "the original request id");
      assert.equal(retry.body.meta.commitChecks, first.body.meta.commitChecks);
      // The replay reports the versions of the deployment that answered it.
      assert.equal(retry.body.meta.policyVersion, "policy_routing_2");
      assert.equal(commits(), committed, "no second COMMIT");
      assert.equal(h.hooksSeen.length, hooksBefore, "no second commit check");
      assert.equal(h.rows("a").filter((row) => row.id === "across_snapshot").length, 1, "never executed twice");
      assert.deepEqual((await h.request("a", "/v1/transactions:execute", body, key)).body, retry.body, "replays again");

      // Another body on the same key is another request.
      const changed = await h.request("a", "/v1/transactions:execute", { statements: [insert("other_body")] }, key);
      assert.equal(changed.status, 409, JSON.stringify(changed.body));
      assert.equal(changed.body.error.code, "POLICYSQL_IDEMPOTENCY_CONFLICT");
      // Another generation of the same database (its key hash has no generation) conflicts.
      generation = "2";
      const moved = await h.request("a", "/v1/transactions:execute", body, key);
      assert.equal(moved.status, 409, JSON.stringify(moved.body));
      assert.equal(moved.body.error.code, "POLICYSQL_IDEMPOTENCY_CONFLICT");
      assert.equal(commits(), committed, "nothing else committed");
      assert.equal(h.rows("a").some((row) => row.id === "other_body"), false);
      assert.equal(h.rows("a").filter((row) => row.id === "across_snapshot").length, 1);
      assert.equal(h.databases.get("a").database.prepare("SELECT count(*) AS n FROM policysql_idempotency").get().n, 1);
    });
  }

  // #80, bypass: the snapshot is still checked before the lookup. A request whose binding
  // names the earlier snapshot (a binding captured before the deployment) never reaches the
  // row, so dropping the snapshot from the fingerprint lets no request of an earlier deployment
  // execute or replay under the new one.
  test(`${ownerAdapter}: #80: a keyed retry pinned to the earlier snapshot is stale, not replayed or executed`, async (t) => {
    t.mock.method(console, "log", () => {});
    const h = await harness(t, { ownerAdapter, hooks: false });
    const key = "snapshot-change-key-0002";
    const body = { statements: [insert("stale_retry")] };
    const first = await h.request("a", "/v1/transactions:execute", body, key);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const earlier = h.binding("a");
    h.redeploy({ policyVersion: "policy_routing_2" });
    const response = await h.app.fetch(new Request("https://worker.test/v1/transactions:execute", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body),
    }), { database: earlier, session: h.session("a") }, h.background);
    const stale = await response.json();
    assert.equal(response.status, 409, JSON.stringify(stale));
    assert.equal(stale.error.code, "POLICYSQL_STALE_OPERATION");
    assert.equal(h.rows("a").filter((row) => row.id === "stale_retry").length, 1);
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
