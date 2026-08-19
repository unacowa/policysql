# Cloudflare Workers production measurement

Measured on 2026-08-04 against a temporary `workers.dev` deployment in the NRT
colo with Wrangler 4.118.0. Both temporary Workers were deleted after the run.

## Scope

The WebAssembly bundle contains the production PolicySQL catalog, core,
execution, parser, policy, and SQLite compiler crates. Each measured pipeline
performs parse, identifier binding, policy compilation, typed SQL emission,
independent rendering, emitted-SQL reparse, and invariant sealing.

Catalog construction and policy activation happen once per benchmark request;
the 1,000-iteration figures below primarily represent the query compiler. The
measurement does not include JWT/authentication handling, a Turso client,
database network time, or database execution.

## Deployment

| Metric | Observed |
| --- | ---: |
| Upload | 1,071.24 KiB |
| Gzip upload | 360.03 KiB |
| Worker startup | 4-6 ms |
| Wasm file | 1,091,509 bytes |

## CPU time

Cloudflare Trace Events were used because Workers deliberately do not advance
`performance.now()` during synchronous computation. Each sample below compiled
the same query 1,000 times. Values are Cloudflare `cpuTime` divided by 1,000.
The trace stream sampled only some requests, so `n` is shown explicitly.

| Case | SQL surface | n | min ms | median ms | max ms |
| --- | --- | ---: | ---: | ---: | ---: |
| simple | parameterized SELECT, WHERE, LIMIT | 2 | 0.030 | 0.037 | 0.037 |
| join | LEFT JOIN, alias provenance, ORDER BY | 4 | 0.043 | 0.057 | 0.113 |
| exists | correlated EXISTS subquery | 3 | 0.044 | 0.094 | 0.217 |
| aggregate | COUNT, GROUP BY, HAVING | 5 | 0.019 | 0.032 | 0.103 |
| window | ROW_NUMBER, PARTITION BY, ORDER BY | 4 | 0.026 | 0.132 | 0.155 |
| update | UPDATE with policy check and RETURNING | 5 | 0.022 | 0.025 | 0.054 |

Single-pipeline traces showed warm requests at 0-2 ms and cold-isolate samples
at 38-48 ms. The cold values are dominated by Wasm initialization and policy /
catalog setup, not by the SQL case itself.

## Free-plan assessment

The gzip bundle is about 12% of the 3 MB Free-plan Worker limit, and startup is
far below the 1-second limit. Warm query compilation fits comfortably inside
the 10 ms CPU/request limit. Cold Wasm initialization exceeded 10 ms in the
observed traces, so Free-plan operation is plausible but cannot be considered
reliably within-limit until initialization is reduced or its behavior under a
sustained cold-start workload is validated. Cloudflare documents some
flexibility for infrequent CPU-limit overruns, but it is not a guarantee.

While real-time tailing was attached, intermittent Cloudflare 1042/500 responses
were observed. With tailing detached, 100 consecutive single-query probes
succeeded. The successful CPU samples above exclude failed trace events.
