// ADR 0025, "What happens at the deployment that switches the rule": retries that straddle
// the deployment from ABI 4 (byte equality with `stableJson`) to ABI 5 (core-defined canonical
// JSON), and on to the current ABI (6 since ADR 0024 pull request 4, which keeps ADR 0025's
// stability requirements). The records and rows below hold the values the ABI 4 implementation wrote, computed
// by a frozen copy of it, and the retries run on the current code under the new snapshot.
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

  // Rewrites the stored record with the digests the ABI 4 implementation computed for it.
  const asWrittenByAbi4 = async (h, id) => {
    const record = await h.ownerRecord(id);
    const authFingerprint = await legacyAuthFingerprint(record.auth, record.databaseBinding);
    const commitDigest = await legacyCommandDigest("commit", { sequence: 2 });
    // Equal by ADR 0025 (a)-(d): the new rule computes the same bytes for these inputs.
    assert.equal(record.authFingerprint, authFingerprint, "auth fingerprint is byte-identical across the bump");
    assert.equal(record.commitSent.digest, commitDigest, "commit digest is byte-identical across the bump");
    assert.equal(commitDigest, goldens.find(({ name }) => name === "commit sequence 2").output.digest);
    const value = {
      ...record,
      authFingerprint,
      commitSent: { ...record.commitSent, digest: commitDigest },
      ...(record.status === "committed" ? { last: { ...record.last, digest: commitDigest } } : {}),
    };
    await h.ownerCore(id).persist(value);
    return value;
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

  test(`${ownerAdapter}: a committed record written by ABI 4 replays its commit for an ABI 5 caller`, async (t) => {
    const { h, at, send } = await setup(t);
    at(4);
    const { id, commit } = await openWrite(send, "abi_committed");
    const first = await commit();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const record = await asWrittenByAbi4(h, id);
    assert.match(record.databaseBinding.snapshot, /:abi-4$/u);
    at("current");
    const retry = await commit();
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body, first.body);
    committedOnce(h, "abi_committed");
  });

  test(`${ownerAdapter}: a committing record written by ABI 4 leaves an ABI 5 commit retry unknown, never rejected`, async (t) => {
    const { h, at, send } = await setup(t);
    at(4);
    const { id, commit } = await openWrite(send, "abi_committing");
    let lost = false;
    h.afterDatabaseStatement(({ sql }) => {
      if (!lost && sql === "COMMIT") { lost = true; h.loseOwner(id); }
    });
    await commit();
    const record = await asWrittenByAbi4(h, id);
    assert.equal(record.status, "committing");
    at("current");
    for (const attempt of [1, 2]) {
      const retry = await commit();
      assert.equal(retry.status, 503, `${attempt}: ${JSON.stringify(retry.body)}`);
      assert.equal(retry.body.error.code, UNKNOWN);
    }
    committedOnce(h, "abi_committing");
  });

  test(`${ownerAdapter}: control: a stored digest the new rule does not reproduce would be a definite rejection`, async (t) => {
    // Why ADR 0025 needs (a)-(d) with the bump: had the auth fingerprint or the `{sequence}`
    // digest changed, the retry below would be the 409 that ADR 0007 forbids after COMMIT.
    const { h, at, send } = await setup(t);
    for (const field of ["authFingerprint", "commitSent"]) {
      at(4);
      const { id, commit } = await openWrite(send, `abi_control_${field}`);
      assert.equal((await commit()).status, 200);
      const record = await h.ownerRecord(id);
      const changed = field === "authFingerprint"
        ? { ...record, authFingerprint: "0".repeat(64) }
        : { ...record, commitSent: { ...record.commitSent, digest: "0".repeat(64) }, last: { ...record.last, digest: "0".repeat(64) } };
      await h.ownerCore(id).persist(changed);
      at("current");
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

  test(`${ownerAdapter}: a keyed begin retry across the bump reaches the same owner and conflicts`, async (t) => {
    const { h, at, send, credential } = await setup(t);
    const key = "abi-bump-begin-0001";
    at(4);
    const first = await send("/v1/transactions", { mode: "write" }, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const auth = { principal: credential.principal, subject: credential.subject, role: credential.defaultRole, session: credential.session };
    const keyHash = await legacyKeyHash(auth, "interactive-start", h.binding("a"), key);
    assert.equal(first.body.transactionId, `tx_${keyHash.slice(0, 32)}`, "the ABI 4 transaction id");
    at("current");
    const retry = await send("/v1/transactions", { mode: "write" }, key);
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error.code, "POLICYSQL_TRANSACTION_CONFLICT");
    assert.deepEqual(h.ownerNames(), [first.body.transactionId], "no second owner");
  });
}
