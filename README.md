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
