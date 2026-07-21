# AgentCred

Monorepo scaffold for a scoped credential issuer and verifier for agent-to-agent calls.

See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the complete project plan and current
phase status. Architecture choices and tradeoffs are recorded in
[DECISIONS.md](./DECISIONS.md).

## Phase 0: local setup

Prerequisites: Node.js 22+, pnpm 10+, and Docker with Docker Compose.

```sh
pnpm install
pnpm db:up
pnpm db:verify
```

PostgreSQL listens only on `127.0.0.1:5432`. On the first startup, Docker runs
`db/schema.sql` automatically and creates the `issuances`, `revocations`, and
`verification_log` tables.

The local connection string is:

```text
postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred
```

Set `POSTGRES_PASSWORD` or `POSTGRES_PORT` before starting Compose to override the
development defaults. To rerun the schema from a clean database, use
`pnpm db:reset`. This deletes the local PostgreSQL volume.

## Phase 1: local issuer

The issuer is a loopback-only demonstration service. Its `POST /issue` endpoint is
intentionally unauthenticated in Phase 1, so do not expose port 3000 to an untrusted
network.

Generate a local ES256 signing keypair and start the issuer:

```sh
pnpm issuer:keys
pnpm issuer:dev
```

Key generation refuses to replace an existing pair unless you explicitly run
`pnpm issuer:keys -- --force`. Generated keys live in the gitignored `issuer/keys/`
directory.

Issue a five-minute credential from another terminal:

```sh
curl --fail-with-body http://127.0.0.1:3000/issue \
  --header 'content-type: application/json' \
  --data '{
    "agent_id": "agent-a",
    "principal": "company-x",
    "scope": ["read:weather"],
    "aud": "agent-b",
    "ttl": 300
  }'
```

The response contains a bearer credential and should not be copied into logs or shared.
Decode it locally with `jose` and `issuer/keys/public.pem`, or use a short-lived throwaway
token if inspecting it on jwt.io. The full endpoint and claim contracts are documented
in [API_REFERENCE.md](./API_REFERENCE.md).

Run the verification suites with PostgreSQL healthy:

```sh
pnpm issuer:test
pnpm issuer:test:integration
pnpm --filter @agent-cred/issuer typecheck
pnpm --filter @agent-cred/issuer build
```

## Phase 2: verifier SDK

The verifier SDK validates an ES256 credential's signature, issuer, expiry, audience,
required claims, revocation status, and exact requested scope. It fails closed if the
revocation source is unavailable. A Fastify pre-handler is included for protecting
individual routes and attaches verified claims to allowed requests.

The public API and middleware response contract are documented in
[API_REFERENCE.md](./API_REFERENCE.md). Run its verification gates with PostgreSQL
healthy:

```sh
pnpm verifier:test
pnpm verifier:test:integration
pnpm --filter @agent-cred/verifier-sdk typecheck
pnpm --filter @agent-cred/verifier-sdk build
```

Phase 2 reads the existing `revocations` table. Phase 3 adds verification audit writes,
Phase 4 adds the revoke endpoint, and Phase 5 will replace the injected database lookup
with a Redis-backed implementation.

## Phase 3: demo agents

Phase 3 demonstrates attempted overreach rather than simulating an intelligent agent.
Agent A is a deterministic one-shot client; Agent B exposes a static protected quote
so the credential boundary remains the visible behavior.

Run PostgreSQL first. On a fresh volume, Compose applies `db/schema.sql`
automatically; do not reapply that non-idempotent file to an initialized database.

```sh
pnpm db:up
pnpm issuer:keys # first run only; generation refuses to overwrite existing keys
```

Then use three terminals for the local services and demo trigger:

```sh
# Terminal 1
pnpm issuer:dev

# Terminal 2
pnpm agent-b:dev

# Terminal 3
pnpm agent-a:demo
```

Agent A prints a unique `principal`. Use it to retrieve only that run's audit evidence:

```sh
docker compose exec -T postgres psql -U agentcred -d agentcred -c \
  "SELECT jti, decision, denial_reason, requested_action, audience, verified_at FROM verification_log WHERE principal = 'PASTE_PRINTED_PRINCIPAL' ORDER BY id;"
```

The result must contain a `deny` / `scope_exceeded` row followed by an `allow` row.
Neither terminal output nor audit metadata includes the bearer credentials.

Run the complete local Phase 3 gate with PostgreSQL healthy:

```sh
pnpm phase3:verify
```

CI remains deferred to Phase 9; this command and the manual walkthrough are the Phase
3 completion evidence.

### Audit availability tradeoff

Agent B awaits each audit insert so the response and durable evidence remain closely
correlated. This adds one database round trip. A failed insert is retried once after
100 ms; if both attempts fail, Agent B logs the audit gap loudly but preserves the
already-finalized authorization response. This fail-open audit policy favors service
availability. A compliance-oriented system may instead fail closed, while a
latency-oriented system may use an outbox or fire-and-forget queue.

## Phase 4: revocation and denial reporting

The issuer's `POST /revoke` endpoint accepts a stored JTI and an optional reason.
Revocation is permanent and idempotent: a retry returns the original timestamp and
reason. The endpoint is intentionally unauthenticated for this loopback-only demo and
must not be exposed to an untrusted network.

With PostgreSQL, the issuer, and Agent B running as described above, issue a correctly
scoped credential and retain it only in shell variables:

```sh
ISSUED=$(curl --fail-with-body http://127.0.0.1:3000/issue \
  --header 'content-type: application/json' \
  --data '{
    "agent_id": "agent-a",
    "principal": "phase4-demo",
    "scope": ["read:quote:basic"],
    "aud": "agent-b",
    "ttl": 300
  }')
TOKEN=$(printf '%s' "$ISSUED" | node -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).token))')
JTI=$(TOKEN="$TOKEN" node -e \
  'const p=process.env.TOKEN.split(".")[1];process.stdout.write(JSON.parse(Buffer.from(p,"base64url")).jti)')
```

The first protected call succeeds. Revoke the JTI, then retry the identical credential:

```sh
curl --fail-with-body http://127.0.0.1:3001/get-quote \
  --header "authorization: Bearer $TOKEN"

curl --fail-with-body http://127.0.0.1:3000/revoke \
  --header 'content-type: application/json' \
  --data "{\"jti\":\"$JTI\",\"reason\":\"phase 4 walkthrough\"}"

curl --include http://127.0.0.1:3001/get-quote \
  --header "authorization: Bearer $TOKEN"
```

The last response is `401` with `{"error":"credential_denied","reason":"revoked"}`.
The shell variables contain the bearer credential, so unset them when finished:

```sh
unset ISSUED TOKEN JTI
```

Show denial activity from the previous hour, grouped by reason:

```sh
pnpm report:denials
```

The report returns `denial_reason`, `denial_count`, `first_occurrence`, and
`latest_occurrence`, ordered by count and reason. Run the complete Phase 4 gate with
PostgreSQL healthy:

```sh
pnpm phase4:verify
```

## Phase 5: distributed revocation cache

Phase 5 moves normal revocation reads to Redis while PostgreSQL remains authoritative.
Start both backing services before the issuer and Agent B:

```sh
pnpm services:up
pnpm issuer:dev
pnpm agent-b:dev
```

`POST /revoke` writes PostgreSQL first and then Redis. A successful response therefore
makes the revocation visible to Agent B immediately. If Redis propagation fails after
the database commit, the endpoint returns `503 revocation_propagation_unavailable`;
retrying the request republishes the original immutable revocation.

Out-of-band PostgreSQL writes demonstrate the consistency tradeoff. The issuer performs
a full sync every five seconds by default. While its freshness lease is current, Agent B
trusts a missing Redis JTI as not revoked, so a direct database revocation can remain
temporarily usable until the next sync. Redis errors or an expired freshness lease fall
back to PostgreSQL; failure of both sources returns `503 verification_unavailable`.

The live default-interval walkthrough on 2026-07-21 produced:

| Path | Evidence |
|---|---|
| API write-through | protected call `200` before revoke, revoke `200`, identical call `401` immediately after |
| Out-of-band sync | final stale allow at 4.923s; first denial at 5.029s after the database write |

The extra 29 ms is within the walkthrough's 100 ms observation polling resolution.
This is bounded-staleness evidence, not a performance claim. Repeatable PostgreSQL vs.
Redis p50/p95/p99 and throughput measurements remain Phase 7 work.

Configuration defaults are `REDIS_URL=redis://127.0.0.1:6379` and
`REVOCATION_SYNC_INTERVAL_SECONDS=5`. Revocation keys expire with their JWT, while the
freshness lease expires after three missed sync intervals. Run the complete gate with
both backing services healthy:

```sh
pnpm phase5:verify
```
