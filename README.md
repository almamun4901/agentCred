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
This is bounded-staleness evidence; Phase 7 measures performance separately below.

Configuration defaults are `REDIS_URL=redis://127.0.0.1:6379` and
`REVOCATION_SYNC_INTERVAL_SECONDS=5`. Revocation keys expire with their JWT, while the
freshness lease expires after three missed sync intervals. Run the complete gate with
both backing services healthy:

```sh
pnpm phase5:verify
```

## Phase 6: principal-scoped rate limiting

Phase 6 adds configurable request budgets without placing them in JWTs. PostgreSQL
stores exact policies by principal, audience, and scope; Redis atomically enforces a
fixed window shared by every credential for that tuple. Rotating to a new JTI therefore
does not reset the budget.

Apply the non-destructive schema migration after starting the stateful services:

```sh
pnpm services:up
pnpm db:migrate
```

Agent B evaluates signature and claims, revocation, and exact scope before consuming
rate capacity. A missing policy means unlimited access. A policy or Redis failure
fails closed as `503 verification_unavailable`; exceeding a policy returns `429
rate_limited` with `Retry-After`. Fixed windows are intentionally simple and can allow
boundary bursts; sliding-window enforcement remains a production evolution.

With the issuer and Agent B running, the repeatable demo installs a local 3/minute
policy, clears only that demo counter, issues two credentials for the same principal,
and proves that the fourth alternating-token request is denied:

```sh
pnpm phase6:demo
```

Run the complete Phase 6 gate with PostgreSQL and Redis healthy:

```sh
pnpm phase6:verify
```

## Phase 7: verifier load test

Phase 7 exercises the Fastify verifier middleware through its in-memory injection
path, retaining JWT verification and route handling while excluding socket latency and
PostgreSQL audit writes. Each scenario ran three five-second trials after a two-second
warm-up. Latency percentiles use the same concurrency of 32; throughput is the best
median from the 1/8/32/64 concurrency sweep.

| Scenario | p50 (ms) | p95 (ms) | p99 (ms) | Max sustained req/s |
|---|---:|---:|---:|---:|
| PostgreSQL revocation | 1.679 | 2.676 | 3.472 | 18,331 |
| Redis revocation | 0.795 | 1.190 | 2.702 | 46,454 |
| Redis revocation + PostgreSQL policy + Redis rate limit | 2.152 | 3.297 | 4.258 | 15,268 |

On the recorded Apple M5 Pro local run, Redis cut median revocation latency by 52.7%
and reached 2.53 times PostgreSQL's peak throughput. The rate-limited path shows the
cost of retaining an exact PostgreSQL policy read before the Redis counter operation;
it is evidence to evaluate a future bounded-stale policy cache, not a production
capacity claim. Full environment metadata and methodology are in
[PERFORMANCE.md](./PERFORMANCE.md).

With PostgreSQL and Redis healthy, reproduce the benchmark or run its complete gate:

```sh
pnpm phase7:benchmark
pnpm phase7:verify
```

## Phase 8: containerized local stack

Phase 8 packages the issuer, Agent B, and the one-shot Agent A demo as immutable
multi-stage images. PostgreSQL and Redis remain the stateful backing services. Start
the long-running stack, then run the deny-then-allow demo entirely on the private
Compose network:

```sh
docker compose up --build --wait
docker compose --profile demo run --rm agent-a
```

The first command initializes a local ES256 keypair in named volumes. The issuer
mounts only the private-key volume and Agent B mounts only the public-key volume;
neither key is copied into an image. Application containers run as UID 10001 with a
read-only root filesystem, dropped capabilities, health checks, and graceful signal
handling. Host-published ports remain bound to `127.0.0.1`.

Normal restarts and `docker compose down` preserve PostgreSQL, Redis, and the signing
identity. `docker compose down --volumes` intentionally deletes all four local data
volumes, including the signing identity, so the next startup generates a new keypair.

The full Phase 8 gate first runs every earlier regression gate, then creates an
isolated clean-volume Compose project on alternate host ports. It verifies the
containerized demo, audit evidence, non-root execution, private-key isolation, image
contents, health, and key persistence before removing only its test-scoped volumes:

```sh
pnpm phase8:verify
```
