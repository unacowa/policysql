// Protocol-level fixture. Gateway/Wasm/SQLite conformance is tested separately.
export const mockGateway = ({ rows = [{ id: "post_1", title: "Original", display_name: "Original", status: "draft" }], affectedRows = 1 } = {}) => {
  const calls = [];
  const transactions = new Map();
  let nextId = 0;
  const result = (sql) => {
    const mutation = !/^select\b/i.test(sql);
    const returned = !mutation || /\breturning\b/i.test(sql) ? rows : [];
    return { rows: returned, rowCount: returned.length, affectedRows: mutation ? affectedRows : 0, meta: { result: { columns: [], redactions: [] } } };
  };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    const call = { path, body, headers: new Headers(init.headers), text: init.body };
    calls.push(call);
    if (path === "/v1/transactions:execute") return Response.json({ status: "committed", results: [result(body.statements[0].sql)], meta: {} });
    if (path === "/v1/transactions") {
      const id = `tx_${(++nextId).toString(16).padStart(32, "0")}`;
      const expiresAt = new Date(Date.now() + 4_000).toISOString();
      transactions.set(id, { sequence: 1, status: "active", mode: body.mode });
      return Response.json({ transactionId: id, status: "active", nextSequence: 1, expiresAt, meta: {} }, { status: 201 });
    }
    const [, , , id, kind] = path.split("/");
    const tx = transactions.get(id);
    if (!tx) return Response.json({ error: { code: "POLICYSQL_TRANSACTION_UNAVAILABLE" } }, { status: 409 });
    const digest = `${kind}:${init.body}`;
    if (tx.last?.digest === digest && body.sequence === tx.sequence - 1) return Response.json(tx.last.response);
    if (body.sequence !== tx.sequence || tx.status !== "active") return Response.json({ error: { code: "POLICYSQL_TRANSACTION_CONFLICT" } }, { status: 409 });
    const response = kind === "statements"
      ? { transactionId: id, status: "active", nextSequence: tx.sequence + 1, result: { sequence: tx.sequence, ...result(body.sql) }, meta: {} }
      : { transactionId: id, status: kind === "commit" ? "committed" : "rolled_back", meta: {} };
    tx.sequence++;
    tx.status = response.status;
    tx.last = { digest, response };
    return Response.json(response);
  };
  return { calls, transactions, fetchImpl };
};
