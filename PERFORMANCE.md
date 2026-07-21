# Performance Log

## 2026-07-21 — Phase 7 verifier middleware benchmark

Commit: `25b3fa9-dirty`

The benchmark uses Fastify's in-memory `inject()` path so JWT verification, bearer
middleware, authorization, and route handling are included without socket or network
latency. PostgreSQL audit observation is excluded. Latency is measured at a fixed
concurrency of 32; maximum sustained throughput is the best median result from the
1/8/32/64 concurrency sweep. Each reported value is the median of three five-second
trials after a two-second warm-up, with scenario order rotated between trials.

| Scenario | p50 (ms) | p95 (ms) | p99 (ms) | Max sustained req/s | Peak concurrency |
|---|---:|---:|---:|---:|---:|
| PostgreSQL revocation | 1.679 | 2.676 | 3.472 | 18,331 | 32 |
| Redis revocation | 0.795 | 1.190 | 2.702 | 46,454 | 64 |
| Redis revocation + PostgreSQL policy + Redis rate limit | 2.152 | 3.297 | 4.258 | 15,268 | 64 |

| Benchmark metadata | Value |
|---|---|
| Captured at | `2026-07-21T05:48:23.725Z` |
| Trials | 3 |
| Warm-up per scenario/trial | 2s |
| Measured duration per run | 5s |
| Fixed latency concurrency | 32 |
| Throughput sweep | 1, 8, 32, 64 |
| Node | v24.12.0 |
| CPU | Apple M5 Pro |
| PostgreSQL | 17.10 |
| Redis | 7.4.9 |

Redis reduced median revocation latency by 52.7% and delivered 2.53 times the peak
throughput of the direct PostgreSQL path on this machine. The rate-limited path was
slower than either revocation-only path because every request deliberately performs a
Redis revocation read, an exact PostgreSQL policy read, and an atomic Redis script.
That result supports measuring a bounded-stale policy cache before adding one; it does
not by itself justify changing the immediate policy-update behavior.

All measured requests returned `200`. The Redis revocation-only scenario performed
2,406,870 real `MGET` operations, and the rate-limited scenario performed another
872,119 alongside the same number of PostgreSQL policy reads and Redis rate-limit
scripts. Neither Redis path used PostgreSQL revocation fallback. The benchmark reader
supplies its own valid freshness value after the real Redis `MGET` so the test does not
overwrite the issuer's global freshness lease.

These are local, in-process middleware measurements rather than end-to-end production
capacity. Reproduce the default run with healthy local PostgreSQL and Redis services:

```sh
pnpm services:up
pnpm db:migrate
pnpm phase7:benchmark
```

Benchmark-only overrides are available as `--scenario`, `--duration`, `--warmup`,
`--concurrency`, `--sweep`, and `--trials`. The comparable log above uses the defaults.
