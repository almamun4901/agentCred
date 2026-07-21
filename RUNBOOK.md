# Runbook

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
