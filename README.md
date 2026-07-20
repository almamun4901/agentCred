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
Phase 4 will add the revoke endpoint, and Phase 5 will replace the injected database
lookup with a Redis-backed implementation.

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
