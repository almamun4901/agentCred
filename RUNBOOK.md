# Runbook

## Containerized local stack

Start the full long-running stack and wait for health gates:

```sh
docker compose up --build --wait
```

Run the one-shot demo without turning Agent A into a long-running service:

```sh
docker compose --profile demo run --rm agent-a
```

- **`key-init` fails:** inspect `docker compose logs key-init`. A partial or mismatched
  pair is rejected rather than silently rotated. For disposable local data only,
  `docker compose down --volumes` removes the database, cache, and key volumes so the
  next startup can generate a clean identity.
- **Issuer or Agent B remains unhealthy:** inspect its logs and the PostgreSQL/Redis
  health state with `docker compose ps`. Both applications fail startup when their
  required dependencies or mounted key are unavailable.
- **Host port already in use:** override `POSTGRES_PORT`, `REDIS_PORT`, `ISSUER_PORT`,
  or `AGENT_B_PORT` for that invocation. Container-to-container ports do not change.
- **Application restart:** `docker compose restart issuer agent-b` preserves the
  signing volumes. A changed signing identity indicates the volumes were explicitly
  removed or a different Compose project name was used.

Issuer and Agent B run with read-only root filesystems as UID 10001. Agent B has no
private-key mount. Do not weaken those controls to troubleshoot a local permission
problem; inspect the key initializer and volume lifecycle instead.

## Local service checks

Start both stateful services and verify Redis:

```sh
pnpm services:up
pnpm db:verify
pnpm redis:verify
```

Redis is local-only at `127.0.0.1:6379`. The issuer performs a full revocation sync
before it starts listening and then repeats it every
`REVOCATION_SYNC_INTERVAL_SECONDS` (five seconds by default).

## Revocation cache incidents

- **Issuer does not start:** check PostgreSQL and Redis health. Initial synchronization
  is required so Agent B never trusts an uninitialized cache.
- **`POST /revoke` returns `503 revocation_propagation_unavailable`:** PostgreSQL has
  already stored the immutable revocation. Restore Redis if necessary and retry the
  same request; the retry safely republishes the original record.
- **Freshness key is absent:** Agent B falls back to PostgreSQL. Check issuer logs for
  `Revocation cache sync failed`; successful runs log `rows_synced` and `duration_ms`.
- **Redis fails after Agent B starts:** verification falls back to PostgreSQL. If both
  sources fail, protected routes return `503 verification_unavailable`.

Inspect only non-secret cache metadata:

```sh
docker compose exec -T redis redis-cli TTL agentcred:revocations:fresh
```

Do not paste bearer credentials into Redis commands or logs.

## Rate-limit operations

Apply the Phase 6 migration without resetting the database:

```sh
pnpm db:migrate
```

Policies are exact matches on `principal`, `audience`, and `scope`. There are no
wildcards. Insert or update policies in PostgreSQL; a missing row means the request is
not rate limited. Agent B reads the policy before executing one atomic Redis fixed-window
operation.

- **Protected requests return `429 rate_limited`:** inspect the matching policy and
  the response's `Retry-After` header. The counter expires just after its window.
- **Protected requests return `503 verification_unavailable`:** check both PostgreSQL
  and Redis. Rate-limit state fails closed rather than bypassing policy.
- **A new token remains limited:** expected behavior. Counters are shared by principal,
  audience, and requested action rather than JTI.
- **Policy update behavior:** a new maximum applies on the next request. Changing the
  window length starts a new counter window.

Run `pnpm phase6:demo` only against the local demo stack. Its setup updates the dedicated
`phase6-demo` policy and deletes only that principal's namespaced counter.
