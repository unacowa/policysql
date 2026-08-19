import { createClient } from "@tursodatabase/serverless/compat";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export class TransactionOwner {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.client = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
    this.transaction = undefined;
    this.rowId = undefined;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/health") {
        const expression = await this.client.execute(
          "SELECT 1 AS one, datetime('now') AS today",
        );
        return json({
          runtime: "cloudflare-durable-object",
          expression: {
            columns: expression.columns,
            columnTypes: expression.columnTypes,
            row: expression.rows[0],
          },
        });
      }

      if (path === "/start") {
        if (this.transaction) return json({ error: "transaction_already_active" }, 409);
        this.rowId = `cf-${crypto.randomUUID()}`;
        this.transaction = await this.client.transaction("write");
        await this.transaction.execute({
          sql: "INSERT INTO spike_events (id, source) VALUES (:id, :source)",
          args: { id: this.rowId, source: "cloudflare-do" },
        });
        return json({ started: true, rowId: this.rowId });
      }

      if (path === "/abort") {
        this.state.abort("PolicySQL transaction-owner loss spike");
        return json({ unreachable: true });
      }

      if (path === "/read") {
        if (!this.transaction) return json({ error: "no_active_transaction" }, 409);
        const visible = await this.transaction.execute({
          sql: "SELECT source FROM spike_events WHERE id = :id",
          args: { id: this.rowId },
        });
        return json({ readYourWrites: visible.rows[0]?.source === "cloudflare-do" });
      }

      if (path === "/finish") {
        if (!this.transaction) return json({ error: "no_active_transaction" }, 409);
        await this.transaction.rollback();
        this.transaction = undefined;
        return json({ rolledBack: true });
      }

      if (path === "/verify") {
        if (this.transaction) return json({ error: "transaction_still_active" }, 409);
        const requestedId = new URL(request.url).searchParams.get("id");
        const result = await this.client.execute({
          sql: "SELECT count(*) AS count FROM spike_events WHERE id = :id",
          args: { id: requestedId ?? this.rowId },
        });
        return json({ persistedRows: Number(result.rows[0].count) });
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (this.transaction) {
        try {
          await this.transaction.rollback();
        } catch {
          // The owner treats connection loss as terminal.
        }
        this.transaction = undefined;
      }
      return json(
        {
          error: "spike_failed",
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (request.headers.get("authorization") !== `Bearer ${env.SPIKE_REQUEST_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const owner = env.TX_OWNER.get(env.TX_OWNER.idFromName("spike-owner"));
    return owner.fetch(request);
  },
};
