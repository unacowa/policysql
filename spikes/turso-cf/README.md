# Turso and Cloudflare transaction spike

This disposable spike checks the external assumptions required by PolicySQL:

- Turso remote batch rollback;
- interactive transaction read-your-writes and transaction hold time;
- concurrent write transaction behavior;
- SQLite `RETURNING` CTE behavior;
- runtime expression metadata;
- LEFT JOIN policy-placement differential behavior;
- the same interactive transaction flow from a deployed Cloudflare Worker.
- forced Durable Object reset while a transaction is open.

It creates a temporary Turso database and Cloudflare Worker, then deletes both in a `finally` block. Database credentials are uploaded as Worker secrets and the temporary local secrets file is removed after the run.

Run from the repository root:

```sh
set -a
. ./.env
set +a
npm --prefix spikes/turso-cf install
npm --prefix spikes/turso-cf run compiler
npm --prefix spikes/turso-cf run spike
```

The sanitized report is written to `spikes/turso-cf/.artifacts/report.json`. The artifact directory is ignored by Git.
