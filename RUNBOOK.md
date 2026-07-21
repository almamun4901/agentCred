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
