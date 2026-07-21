# Project: AgentCred — Scoped Credential Issuer & Verifier for Agent-to-Agent Calls

## Project Progress

Last updated: **2026-07-21**

This file is the source of truth for implementation progress. Task checkboxes are
updated only after the work has been implemented and verified. Architecture choices,
alternatives, and consequences are recorded in [DECISIONS.md](./DECISIONS.md).

| Phase | Status | Evidence / next step |
|---|---|---|
| Phase 0 — Setup | Complete | Workspace discovery and PostgreSQL schema smoke test passed |
| Phase 1 — Issuer Service | Complete | ES256 signing, issuance routes, PostgreSQL integration, and manual verification passed |
| Phase 2 — Verifier SDK | Complete | Strict ES256 verification, PostgreSQL revocation checks, Fastify middleware, and automated verification passed |
| Phase 3 — Demo Agents | Complete | Deny-then-allow live demo and PostgreSQL audit evidence passed |
| Phase 4 — Audit + Revocation | Complete | Idempotent revoke API, denial report, and live lifecycle verified |
| Phase 5 — Revocation Cache | Complete | Redis fast path, safe fallback, and measured 5.029s out-of-band propagation verified |
| Phase 6 — Rate Limiting | Complete | Atomic Redis enforcement, rotation-resistant demo, and audit evidence passed |
| Phase 7 — Load Test | Complete | Three-path middleware benchmark captured latency and throughput evidence |
| Phase 8 — Dockerization | Complete | Clean-volume Compose demo, hardened images, key isolation, and full regression gate passed |
| Phase 9 — CI | Complete | Required strict CI gate passed after recorded red/green PR proof |
| Phase 10 — Terraform | Not started | Intentionally deferred until AWS work resumes |
| Phase 11 — CD | Not started | Intentionally deferred with Phase 10 |
| Phase 12 — README + Framing | Complete | Standalone architecture, evidence, tradeoffs, limitations, and demo narrative published |

Status meanings:

- **Not started:** no phase implementation has been claimed, even if placeholder files exist.
- **In progress:** implementation has begun but the phase verification gate has not passed.
- **Complete:** every required task and the phase verification gate have passed.
- **Blocked:** progress requires a documented external decision or dependency.

## 1. What This Project Does

AgentCred is a minimal, working implementation of the credential/scope-verification
pattern that current agent-identity standards work (NIST AI Agent Standards
Initiative, MCP-I, Google's A2A protocol, IETF agent-authorization drafts) is
converging on. It is not a new protocol — it is a small, honest demonstration
of the core mechanism: an agent presents a short-lived, scoped, signed credential
to another agent's service, and that service verifies signature, expiry, audience,
and scope before allowing the call. If the agent tries to act outside its granted
scope, the call is rejected and logged.

Core pieces:
- **Issuer service** — issues signed, scoped, expiring JWTs on behalf of a principal/agent.
- **Verifier SDK** — a small reusable package that any receiving service can use to
  validate a presented credential before executing an action.
- **Two demo agents** — Agent A (caller) and Agent B (mock service with a protected
  endpoint) to demonstrate both the happy path and the "blocked overreach" path.
- **Audit log + revocation list** — every issuance and verification attempt is logged;
  tokens can be revoked before their TTL expires (addressing the known TTL-only
  revocation gap for agent-speed interactions).
- **Distributed revocation cache** — revocation checks move from a per-request
  Postgres lookup to a Redis cache in front of the verifier, with periodic sync
  back to the issuer's source of truth. This is what turns revocation from "a
  feature that works" into "a system with real consistency tradeoffs" you can
  discuss in an interview.
- **Rate limiting per credential** — beyond binary allow/deny, each credential
  carries a request-rate budget (e.g., 100 req/min) scoped by `scope` and
  `principal`, enforced by the verifier before the scope check.
- **Containerized + deployed** — Dockerized, deployed to AWS (ECS Fargate + RDS),
  with CI/CD via GitHub Actions and infra as Terraform.

## 2. Context / Why This Project

Multi-agent systems (agents calling other agents' tools/services) currently lack a
standard way to answer: "is this agent authorized to do this specific thing, on
behalf of whom, for how long, and can I revoke that authorization mid-flight?"
Several real standards efforts are actively working this problem as of 2026:

- **NIST AI Agent Standards Initiative** (launched Feb 2026)
- **MCP-I** (donated to the Decentralized Identity Foundation)
- **Google's A2A protocol**
- **IETF drafts** — agent authorization profiles for OAuth, agent identity discovery
- **Academic work** on invocation-bound capability tokens

This project implements the smallest honest version of that pattern, to understand
the actual failure modes (e.g., why TTL-only revocation is too slow at agent speed,
why bearer tokens without audience-binding are dangerous for agent-to-agent calls).

**Positioning for resume/interviews:** "I read into the current NIST/IETF work on
agent identity and implemented a minimal working version of scoped credential
issuance and verification to understand the actual failure modes." Not "I invented
agent OAuth."

**Best-fit audiences:** AI infrastructure / LLMOps / forward-deployed engineering
roles at startups, and FDSE-style interviews (e.g., Palantir) that reward "here's an
ambiguous real problem, here's how I scoped it down and found the hard part." Weaker
signal for big-co new-grad screens (Google/Microsoft) and for product-craft-focused
roles (Notion) — include there mainly as a secondary bullet, not the headline project.

**Why the distributed cache and rate limiting matter:** the original v1 (DB-lookup
revocation, binary allow/deny) proves you can implement a known pattern correctly.
These two additions prove you understand *systems* tradeoffs, not just correct
implementation — cache consistency, staleness windows, and multi-tenant fairness
are exactly what separates a "built a demo" story from a "reasoned about a
distributed system" story in an interview. This is the difference that matters
most for infra/LLMOps roles specifically.

## 3. Tech Stack

| Layer | Choice |
|---|---|
| Language/runtime | TypeScript / Node.js |
| API framework | Fastify |
| Auth/token signing | `jose` (ES256 keypair, asymmetric signing) |
| Database | PostgreSQL |
| Cache | Redis (revocation cache, rate-limit counters) |
| Local dev | Docker Compose |
| Testing | Vitest or Jest + Supertest for integration tests |
| Containerization | Docker (multi-stage builds) |
| CI | GitHub Actions (lint, test, build) |
| CD | GitHub Actions → ECR → ECS Fargate |
| Infra as code | Terraform (ECR, ECS cluster/service/task def, RDS, security groups, Secrets Manager) |
| Cloud | AWS (ECS Fargate, RDS Postgres db.t4g.micro, ElastiCache for Redis cache.t4g.micro OR self-hosted Redis container for cost control, Secrets Manager, CloudWatch Logs) |
| Secrets | AWS Secrets Manager / SSM Parameter Store (SecureString) — never env vars in plaintext |

## 4. Repo Structure

```
agent-cred/
├── issuer/
│   ├── src/
│   │   ├── server.ts
│   │   ├── routes/issue.ts
│   │   ├── routes/revoke.ts
│   │   ├── db.ts
│   │   └── sign.ts
│   ├── scripts/gen-keys.ts
│   ├── Dockerfile
│   └── package.json
├── verifier-sdk/
│   ├── src/
│   │   ├── verify.ts
│   │   ├── middleware.ts
│   │   ├── revocation-cache.ts   # Redis-backed revocation lookup + fallback to Postgres
│   │   └── rate-limiter.ts       # per-credential/scope/principal rate limiting via Redis
│   └── package.json
├── issuer/
│   └── src/
│       └── jobs/sync-revocations.ts   # periodic job: issuer's source of truth → Redis
├── demo-agents/
│   ├── agent-a/
│   └── agent-b/
│       └── Dockerfile
├── db/
│   ├── schema.sql
│   └── seed.sql
├── infra/
│   └── terraform/
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
├── docker-compose.yml
└── README.md
```

## 5. Task Breakdown, Start to End

### Phase 0 — Setup (1-2h) — Complete 2026-07-17

- [x] Initialize Git with a `main` branch.
- [x] Initialize the pnpm monorepo and discover `issuer`, `verifier-sdk`, and both demo-agent workspaces.
- [x] Set up PostgreSQL 17 via Docker Compose for local development.
- [x] Write `db/schema.sql` with `issuances`, `revocations`, and `verification_log` tables.
- [x] Add local database lifecycle and verification scripts.
- [x] Document local startup, connection settings, and reset behavior.

**Testing after this task:** `docker compose up` brings up Postgres cleanly; can connect via `psql` and confirm tables exist after running schema.sql.

**Verification recorded 2026-07-17:**

- `pnpm -r list --depth -1` discovered all five workspace projects.
- Docker Compose downloaded PostgreSQL, created a persistent volume, and reported the container healthy.
- `psql` confirmed all three required tables exist.
- A transaction inserted an issuance, its revocation, and a denied verification event;
  a join across all three returned the expected record. The transaction was rolled back
  so the smoke test left no application data behind.
- `docker compose config -q` and `git diff --check` passed.

**Known limitations accepted for Phase 0:**

- Schema files in `/docker-entrypoint-initdb.d` run only when the PostgreSQL volume is
  empty. `pnpm db:reset` recreates a local database; a migration tool is required before
  shared or production environments are introduced.
- The checked-in password is a local-only default, and PostgreSQL binds to `127.0.0.1`.
  Deployed secrets must use AWS Secrets Manager or SSM as required by the architecture.
- Later-phase source files are placeholders and do not count as completed work.

---

### Phase 1 — Issuer Service (4-6h)
- [x] Package setup and runtime configuration.
- [x] `gen-keys.ts` — generate a local, gitignored ES256 PEM keypair with safe overwrite behavior.
- [x] `sign.ts` — sign the complete credential claim contract through `jose`.
- [x] PostgreSQL issuance repository.
- [x] `POST /issue` with request validation, persistence, and JWT response.
- [x] `GET /issuances/:jti` metadata-only debugging endpoint.
- [x] Unit and PostgreSQL integration test coverage implemented.
- [x] Automated verification gate: typecheck, unit tests, integration tests, and build.
- [x] Manual verification gate: generate keys, issue a token, verify it, and inspect stored metadata.
- [x] Documentation and security-diff review complete.

**Testing after this task:**
- Unit test: token is signed correctly, decodes with matching public key.
- Unit test: `exp` claim matches `iat + ttl`.
- Integration test: `POST /issue` with valid payload returns 200 + token; missing `scope` returns 400.
- Manual: issue a token via curl, decode it on jwt.io (or a script) and eyeball the claims.

**Verification recorded 2026-07-17:**

- TypeScript type-checking and the production build passed.
- Fifteen unit/route tests passed, covering ES256 verification, the complete claim
  contract, exact TTL arithmetic, unique JTIs, required and boundary validation,
  metadata lookup, 404 behavior, and sanitized persistence failure.
- Two PostgreSQL integration tests passed against the Compose database. The valid
  route test verified the token with the matching public key, compared its JTI and
  timestamps with the stored row, and retrieved it through the debugging endpoint.
  The missing-scope case returned 400 without generating a JTI or inserting a row.
- Local key generation produced a PKCS#8 private key with mode `0600` and an SPKI
  public key with mode `0644`; a second run refused to overwrite them.
- A live loopback issuer issued a five-minute credential. Local public-key verification
  confirmed the ES256 header, every required claim, `exp = iat + 300`, and matching
  metadata from `GET /issuances/:jti`.
- Integration and manual verification rows were removed afterward. Generated keys,
  build output, dependencies, and environment files remain ignored by Git.

**Known limitations accepted for Phase 1:**

- `POST /issue` has no caller authentication and is safe only as a loopback local demo.
- Local PEM rotation and distribution are manual; deployment must move private-key
  handling to managed secret or signing infrastructure.
- TTL is capped at one hour and delegation input, revocation state, and verifier
  behavior remain intentionally deferred to later phases.

---

### Phase 2 — Verifier SDK (4-6h)
- [x] Strict ES256 signature, issuer, expiry, audience, and credential-claim validation.
- [x] Dependency-injected revocation interface with a PostgreSQL implementation.
- [x] Exact, case-sensitive scope enforcement after the revocation check.
- [x] Stable typed allow/deny results with sanitized failure reasons.
- [x] Fastify bearer-token `preHandler` with 401, 403, and 503 behavior.
- [x] Verified claims attached to allowed requests only.
- [x] Package exports, scripts, type declarations, and usage documentation.
- [x] Unit, middleware, PostgreSQL integration, typecheck, and build gates passed.

**Testing after this task (this is the core logic — test thoroughly):**
- Unit test: valid token + in-scope action → allow.
- Unit test: expired token → deny, reason `expired`.
- Unit test: wrong audience → deny, reason `aud_mismatch`.
- Unit test: revoked `jti` → deny, reason `revoked`.
- Unit test: action not in scope → deny, reason `scope_exceeded`.
- Unit test: malformed/tampered signature → deny, reason `invalid_signature`.
- These 6 cases are the backbone of your demo narrative — don't skip any.

**Verification recorded 2026-07-18:**

- Twenty-seven unit and middleware tests passed. Coverage includes allowed credentials,
  expiry, audience and issuer mismatch, revocation-before-scope ordering, exact scope
  matching, tampering, malformed claims, revocation-store failure, bearer parsing,
  HTTP status mapping, request claim attachment, route short-circuiting, and token
  non-disclosure.
- A PostgreSQL integration test inserted an issuance, confirmed it was initially not
  revoked, inserted its JTI into `revocations`, and confirmed the signed credential was
  denied as `revoked`. Test data was removed afterward.
- Type-checking and the production build passed for `@agent-cred/verifier-sdk`.

**Phase boundary:**

- Phase 2 owns the revocation read path and fails closed when PostgreSQL is unavailable.
- Phase 3 adds verification audit logging; Phase 4 adds the revoke write endpoint.
- Phase 5 can replace the injected PostgreSQL checker with Redis without changing the
  cryptographic or scope-verification logic.

---

### Phase 3 — Demo Agents (4-6h) — Complete 2026-07-20
- [x] **Agent B**: mock service with `GET /get-quote` protected by verifier middleware, requiring scope `read:quote:basic`.
- [x] **Agent A**: script that requests a credential from the issuer (scope `read:weather` only), then:
  1. Calls `/get-quote` on Agent B with a token that lacks the right scope → expect 403, log it.
  2. Requests a new token with correct scope → calls `/get-quote` again → expect 200.
- [x] Wire both allowed and denied attempts into `verification_log` through an awaited, fail-open verifier observer.

**Testing after this task:**
- End-to-end script run: confirm one denied call and one allowed call appear correctly in `verification_log` with correct `decision` and `denial_reason`.
- Manual walkthrough: this is your "attempted overreach gets blocked" demo — record the terminal output or a short screen capture for your portfolio/README.

**Verification recorded 2026-07-20:**

- The aggregate `pnpm phase3:verify` gate passed against PostgreSQL: 54 unit tests
  across the issuer, verifier, and demo agents; four database-backed integration
  cases; type-checking; and production builds for all affected packages.
- Observer tests prove trusted identifiers are available for scope decisions,
  untrusted JWT data is not exposed, and failures in both the observer and its error
  handler cannot change the finalized authorization result.
- Agent B's real-timer failure tests confirmed one 100 ms retry, loud final-error
  reporting, token non-disclosure, and unchanged 200/403 responses.
- A live loopback walkthrough issued two credentials for principal
  `phase3-demo-c26c7cdb-41d2-47ef-be9b-a624edbd9471`. Agent A printed the expected
  403 denial followed by the 200 quote response without printing either credential.
- PostgreSQL contained exactly two matching audit rows in order: `deny` with
  `scope_exceeded`, then `allow` with a null denial reason. Both recorded action
  `read:quote:basic`, audience `agent-b`, and timestamps six milliseconds apart.

**Known limitations accepted for Phase 3:**

- Audit writes are awaited and add a database round trip, but remain fail-open after
  one retry. A stricter compliance threat model may require fail-closed behavior or a
  durable outbox.
- Agent A is deterministic and Agent B returns static content; the demo proves the
  credential boundary, not agent intelligence or business logic.
- Local services remain separate Node processes. Redis readiness, service
  containerization, and CI enforcement remain in their documented later phases.

---

### Phase 4 — Audit Log + Revocation (3-5h)

- [x] `POST /revoke` validates a JTI and optional reason, then atomically creates or
  returns an immutable first-write revocation.
- [x] Unknown issuances return `404`; duplicate and concurrent requests remain
  idempotent without replacing the original timestamp or reason.
- [x] The existing verifier revocation read path is exercised through the real write
  endpoint without changing the verifier contract.
- [x] `pnpm report:denials` shows denials from the previous hour grouped by reason.

**Testing after this task:**
- Integration test: issue a token, revoke it, attempt to use it → expect deny with reason `revoked`, even though `exp` has not passed.
- Confirm revocation check happens fast enough not to bottleneck the demo (should be a single indexed lookup).

**Verification recorded 2026-07-20:**

- The aggregate `pnpm phase4:verify` gate passed: 65 unit tests across all packages,
  nine PostgreSQL integration cases, all affected typechecks, and all production
  builds.
- Route and repository coverage includes malformed input, extra-field rejection,
  optional reasons, sanitized failures, unknown JTIs, repeated revocation, and two
  concurrent requests producing exactly one immutable row.
- The lifecycle integration issued a valid unexpired credential, allowed it, revoked
  it through `POST /revoke`, denied the same token as `revoked`, and stored ordered
  allow/deny audit evidence.
- A live loopback walkthrough for principal `phase4-live-019f808e` returned 200 before
  revocation, 200 from the revocation endpoint, and 401 `revoked` afterward. The denial
  report grouped the resulting event under `revoked` without exposing the credential.
- A rolled-back 1,000-row query-plan check used an `Index Only Scan` on
  `revocations_pkey`; the measured lookup completed in 0.010 ms on the local database.

**Known limitations accepted for Phase 4:**

- Issuance and revocation remain unauthenticated and loopback-only. Operator
  authentication and authorization are mandatory before network exposure.
- Revocation reasons are immutable; corrections require a future append-only
  annotation model rather than rewriting security evidence.
- PostgreSQL remains on the request path. Redis propagation and its explicit
  consistency/staleness tradeoffs remain Phase 5 work.

---

### Phase 5 — Distributed Revocation Cache (5-7h)

Move revocation checks off the request-critical-path Postgres lookup and onto Redis,
with periodic sync back to the issuer as source of truth.

- [x] Add persistent, loopback-only Redis with health checks to Docker Compose.
- [x] Add expiring per-JTI cache entries and a freshness-gated Redis checker with
  PostgreSQL fallback.
- [x] Add a non-overlapping full synchronizer with a configurable five-second interval,
  initial startup sync, freshness lease, and structured run metrics.
- [x] Write through successful and idempotent API revocations; return a retryable,
  sanitized `503` if propagation fails after PostgreSQL commits.
- [x] Configure Agent B with Redis readiness, PostgreSQL fallback, and clean client
  shutdown without changing the verifier contract.
- [x] Cover cache, synchronization, write-through, TTL, staleness, and outage behavior
  with unit and PostgreSQL/Redis integration tests.

**Testing after this task:**
- Unit test: `isRevoked` hits Redis, returns true/false correctly for known keys.
- Unit test: simulate Redis unavailable (mock connection failure) → falls back to Postgres lookup, does not throw/allow-by-default.
- Integration test — **fast path**: revoke via `POST /revoke` → immediately attempt to use the token → denied instantly (write-through worked).
- Integration test — **slow path (staleness demo)**: insert a revocation directly into Postgres (bypassing the API), attempt to use the token *before* the next sync tick → currently still allowed (stale cache) → wait for sync interval → attempt again → now denied. Capture the timestamps of both attempts for your README as a concrete "here is the staleness window" artifact.
- This staleness window number (e.g., "up to 5s of stale-allow risk with a 5s sync interval") is itself a resume-worthy sentence — record it.

**Discussion points to write into the README (this is the point of the feature):**
- *Consistency:* eventual consistency between issuer (source of truth) and verifier's cache; write-through narrows the window for API-driven revocations, sync interval bounds it for out-of-band ones.
- *Cache invalidation:* explicit invalidation (write-through on revoke) vs. TTL-based expiry of cache entries themselves (should a Redis key ever expire before its underlying JWT does?).
- *Stale reads:* the demonstrated window above, and what class of risk it represents (a revoked-but-still-cached-as-valid token being allowed for up to `sync_interval_seconds`).
- *Performance:* compare p50/p99 latency of `isRevoked` via Redis vs. direct Postgres lookup under a simple load test (see Phase 7 below) — this is your actual "why we did this" evidence, not just an assumption.

**Verification recorded 2026-07-21:**

- The aggregate `pnpm phase5:verify` gate passed: 84 unit tests, 12 integration
  cases, all workspace typechecks and production builds, the denial report, Redis
  `PONG`, and Compose validation.
- Redis and PostgreSQL integration tests proved immediate API write-through, an
  authoritative healthy cache miss, periodic convergence, credential-bounded TTLs,
  and PostgreSQL fallback during Redis failure.
- The default five-second live walkthrough returned `200` before API revocation and
  `401` immediately after it. An out-of-band database revocation produced a final
  stale allow after 4.923 seconds and the first denial after 5.029 seconds, including
  100 ms observation polling resolution.
- Performance benchmarking remains explicitly deferred to Phase 7; Phase 5 records
  consistency behavior without claiming unmeasured latency or throughput gains.

**Known limitations accepted for Phase 5:**

- A healthy cache may allow an out-of-band revoked credential until the next sync.
- Full active-set synchronization is suitable for this demo, not an unbounded table;
  incremental or event-driven propagation is the production evolution.
- Synchronization runs inside one issuer process without leader election. Redis and
  PostgreSQL remain local and unauthenticated at the service layer.

---

### Phase 6 — Rate Limiting Per Credential (4-6h)

Move from binary allow/deny to a request-rate budget enforced per credential,
scoped by `scope` and `principal` (not just per-`jti`, since a principal issuing
many short-lived credentials shouldn't be able to bypass a limit by rotating tokens).

- [x] Add an exact PostgreSQL policy table keyed by principal, audience, and scope,
  plus a non-destructive migration for existing local volumes.
- [x] Implement a collision-safe, atomic Redis fixed-window counter using Redis server
  time, credential-independent keys, bounded expiry, and no over-limit increments.
- [x] Inject optional rate limiting after signature, revocation, and exact scope checks;
  fail closed when policy or counter enforcement is unavailable.
- [x] Map exhausted budgets to `429 rate_limited` with `Retry-After` and persist the
  distinct `deny_rate_limited` audit decision.
- [x] Wire Agent B to PostgreSQL policy resolution and shared Redis enforcement.
- [x] Add a repeatable two-token Agent A demo proving that JTI rotation does not reset
  a principal's three-request budget.
- [x] Cover policy resolution, key isolation, malformed Redis responses, ordering,
  failure behavior, concurrency, middleware, audit, and the demo with automated tests.

**Testing after this task:**
- Unit test: N requests under the limit → all allowed, counter increments correctly.
- Unit test: request N+1 within the window → denied with `deny_rate_limited`, counter does not increment past the limit.
- Unit test: window reset — after the window elapses, counter resets and requests are allowed again.
- Unit test: two different `principal`s hitting the same `scope` have independent counters (no cross-tenant bleed).
- Integration test: full demo run — burst of requests from Agent A against a 3/min policy, confirm exactly 3 allowed then subsequent ones return 429 until window resets.
- Load consideration: confirm the rate-limit check (Redis `INCR` + `EXPIRE`) doesn't meaningfully add latency vs. the Phase 5 baseline — this ties directly into the performance discussion point above.

**Discussion points for the README:**
- Why `principal:scope` and not `jti` — prevents rate-limit evasion via token rotation.
- Fixed-window vs. sliding-window tradeoffs (fixed window is simpler but allows bursting at window boundaries — worth explicitly naming as a known simplification if you go fixed-window for time).
- How this composes with revocation: order of checks in the verifier (signature → aud
  → revocation → scope → rate limit), and why unauthorized requests must not consume
  a legitimate principal/action budget.

**Verification recorded 2026-07-21:**

- The aggregate `pnpm phase6:verify` gate passed all workspace unit tests,
  PostgreSQL/Redis integration tests, typechecks, production builds, the denial report,
  Redis health check, Compose validation, and the idempotent schema migration.
- Ninety-six unit tests and fourteen integration cases pass with the completed demo
  test included.
- Twelve concurrent attempts against a three-request policy produced exactly three
  allows and nine denials; the stored Redis count remained exactly three.
- Agent B integration alternated two different JTIs for one principal, allowed the
  first three calls, returned `429` with `Retry-After` on the fourth, and stored
  `deny_rate_limited` / `rate_limited` in PostgreSQL.
- The implementation intentionally checks exact scope before consuming capacity,
  correcting the earlier outline so an out-of-scope credential cannot drain a
  legitimate action budget.

**Known limitations accepted for Phase 6:**

- Fixed windows allow boundary bursting; sliding windows or token buckets remain a
  production evolution.
- Exact PostgreSQL policy resolution remains on each rate-limited request path. Phase 7
  measures its cost before adding a bounded-stale policy cache.
- Policies have no wildcard precedence or management API; a missing exact policy means
  unlimited access, and local demo policy setup is intentionally operator-driven.

---

### Phase 7 — Simple Load Test (2-3h) — Complete 2026-07-21

Added specifically to produce real numbers for the Phase 5/6 performance discussion,
not as a standalone feature.

- [x] Use a custom script to hit the verifier middleware directly through Fastify
  injection, bypassing socket and network hops while retaining common JWT and route
  work.
- [x] Run three benchmark-only scenarios: direct PostgreSQL revocation, Redis
  revocation with an unused PostgreSQL fallback, and Redis revocation plus exact
  PostgreSQL policy resolution and atomic Redis enforcement.
- [x] Record median-of-three p50/p95/p99 latency at concurrency 32 and maximum median
  throughput across a 1/8/32/64 concurrency sweep.

**Testing after this task:**
- [x] Numbers are captured in `PERFORMANCE.md` and the README as evidence behind the
  Redis performance discussion.

**Verification recorded 2026-07-21:**

- The default three-trial run measured PostgreSQL revocation at 1.679 ms p50 and
  18,331 req/s, Redis revocation at 0.795 ms and 46,454 req/s, and Redis revocation
  plus policy/rate limiting at 2.152 ms and 15,268 req/s.
- Backend operation counters proved the Redis scenarios performed no PostgreSQL
  revocation fallback, while the rate-limited scenario exercised both PostgreSQL
  policy resolution and the Redis script on every request.
- The Phase 6 regression gate passed 107 unit tests, 14 integration cases, every
  workspace typecheck and build, the denial report, Redis readiness, and the
  rate-limit concurrency test. The real-backend Phase 7 smoke run also passed.

**Known limitations accepted for Phase 7:**

- Results describe local in-process middleware behavior on one Apple M5 Pro, not
  networked or production capacity.
- The benchmark excludes audit writes to isolate authorization-path cost and supplies
  a benchmark-local freshness value after each real Redis `MGET` to avoid mutating the
  issuer's global freshness lease.

---

### Phase 8 — Dockerization (1-2h) — Complete 2026-07-21

- [x] Digest-pinned multi-stage images for issuer, Agent B, and one-shot Agent A.
- [x] Compiled production deployments run as UID 10001 with read-only root filesystems,
  dropped capabilities, health checks, and graceful signal handling.
- [x] Idempotent key initializer creates or validates the local ES256 pair without
  copying key material into an image.
- [x] Private and public key volumes are separated so Agent B cannot mount the private
  key.
- [x] Compose health-gates PostgreSQL, Redis, key initialization, issuer, and Agent B;
  Agent A remains an explicit `demo` profile.
- [x] Container-specific verification uses its own Compose project, alternate host
  ports, and disposable test-only volumes.

**Testing after this task:**
- [x] `docker compose up --build --wait` from clean volumes brings up the full stack.
- [x] The Phase 3 deny-then-allow demo passes entirely inside containers and leaves
  matching PostgreSQL audit evidence.

**Verification recorded 2026-07-21:**

- `pnpm phase8:verify` passed the complete Phase 7 regression chain: 109 unit tests,
  14 real-backend integration cases, every workspace typecheck and build, the denial
  report, Redis readiness, the rate-limit concurrency test, and the Phase 7 smoke
  benchmark.
- The isolated clean-volume Compose gate built all application and initializer images,
  waited for healthy PostgreSQL, Redis, issuer, and Agent B, then ran Agent A as a
  one-shot profile. It observed `403 scope_exceeded` followed by `200` and queried the
  corresponding `deny` then `allow` audit rows from PostgreSQL.
- Runtime inspection confirmed issuer and Agent B use UID 10001, their images contain
  no PEM/key files, and Agent B has no private-key path. Restarting both applications
  preserved the public-key SHA-256 hash and both health probes recovered.
- The verification harness removed only its `agentcred-phase8-verify` containers,
  network, and volumes after the gate; normal project data was not reset.

**Known limitations accepted for Phase 8:**

- Named volumes are appropriate local secret storage, not the production key design.
  Phase 10/11 must inject secrets from AWS Secrets Manager or move signing to KMS.
- The local initializer runs as root solely to assign the private key to the fixed
  application UID. Long-running application containers remain non-root.
- The monorepo Dockerfiles duplicate dependency/build stages. Shared build caching
  limits the local cost; optimize only if CI evidence shows it is material.
- Key rotation, overlapping verification keys, and JWKS distribution remain out of
  scope; deleting the signing volumes intentionally creates a new local identity.

---

### Phase 9 — CI (GitHub Actions) (2h) — Complete 2026-07-21

- [x] Add a least-privilege, concurrency-canceling `CI` workflow for every push and
  pull request with immutable action pins, Node.js 22, pnpm 10.30.1, frozen installs,
  a 45-minute timeout, and unconditional Compose cleanup.
- [x] Add a repository-wide ESLint flat configuration and root `pnpm lint` command.
- [x] Start PostgreSQL and Redis, lint, and run the full Phase 8 verification chain,
  including all application image builds without publishing them.
- [x] Record a deliberately failing pull-request revision followed by a passing fix.
- [x] Require the `CI` check on `main` with strict checking and administrator
  enforcement.

**Testing after this task:**
- [x] Local frozen install, lint, and complete Phase 8 gate pass.
- [x] Open a PR with a deliberately broken test → confirm CI fails.
- [x] Fix it → confirm CI passes and blocks merge through branch protection.

**Verification recorded 2026-07-21:**

- The first clean GitHub runner exposed that issuer unit tests depended on a locally
  prebuilt verifier package. Commit `acfd083` moved the verifier build ahead of its
  dependents; both push and pull-request runs then passed the complete gate.
- Deliberately broken commit `9f4f58c` failed both `CI` runs in 33-39 seconds. Revert
  `da93adb` removed only that assertion, and corrected runs `29862757184` and
  `29862757732` passed in 2m29s and 2m38s.
- GitHub branch protection on `main` requires the `CI` context, requires branches to
  be up to date, and enforces the rule for administrators. Pull request #1 reports a
  clean, mergeable state only after both corrected checks succeeded.

---

### Phase 10 — Terraform Infra (4-6h)
- `main.tf`: ECR repo, ECS cluster + service + task definition, RDS Postgres instance, ElastiCache Redis instance (cache.t4g.micro) or a Redis container in the same ECS task/service if optimizing for cost, security groups, Secrets Manager secret for signing keys and DB credentials.
- Keep to ~6-7 core resources — no modules, no multi-env workspaces. You should be able to explain every resource line by line in an interview.
- **Cost note:** ElastiCache is not free-tier eligible. If cost is a concern (it should be, given your current situation), run Redis as a sidecar container inside the same ECS task instead of provisioning ElastiCache — same demo value, no extra managed-service cost. Document this tradeoff explicitly in the README as a deliberate cost-vs-realism decision.

**Testing after this task:**
- `terraform plan` runs clean with no errors.
- `terraform apply` successfully provisions resources; manually verify in AWS console (ECR repo exists, RDS instance is `available`, ECS service shows 0/0 tasks since no image pushed yet).
- `terraform destroy` cleanly tears everything down (important for cost control between work sessions).

---

### Phase 11 — CD (GitHub Actions → AWS) (2-3h)
- `.github/workflows/deploy.yml`: on push to `main` — build image, push to ECR, update ECS task definition, force new deployment.
- Optional: post-deploy smoke test hitting `/issue` and `/get-quote` on the live ECS service.

**Testing after this task:**
- Push to `main`, watch the Action run, confirm new ECS task is running the new image (check task definition revision number bumped).
- Hit the live public/ALB endpoint (or via port-forward if no ALB) and re-run the Phase 3 demo against the deployed service.
- Check CloudWatch Logs show the issuance/verification log lines.

---

### Phase 12 — README + Framing (2-4h) — Complete 2026-07-21

- [x] Lead with the agent authorization problem and explicitly distinguish this
  implementation from protocol compliance.
- [x] Cite the NIST AI Agent Standards Initiative and identity work, MCP authorization,
  MCP-I, A2A, and the IETF Agent Authorization Profile draft.
- [x] Include the implemented architecture and verification flow, JWT schema, six core
  verifier cases, deterministic demo, and repository map.
- [x] Publish the Phase 5 stale-read evidence, Phase 6 rate-limit tradeoffs, Phase 7
  benchmark results, and Phase 8/9 container and CI proof.
- [x] Include an explicit limitations section covering bearer replay, issuer auth, key
  rotation, single-issuer trust, delegation, stale revocation reads, fixed-window
  bursting, audit availability, network perimeter, and deferred AWS deployment.
- [x] State that AWS/Terraform/CD work is deferred instead of inventing operational
  lessons before Phases 10 and 11 are executed.

**Verification recorded 2026-07-21:**

- Every local README link resolves, the documented commands and counts match the root
  scripts and Phase 9 evidence, and the token/decision tables match `API_REFERENCE.md`
  and verifier source types.
- The README alone now identifies the trust boundary, describes the deny-then-allow
  proof, distinguishes measured middleware evidence from production capacity, and
  names the main limitations without requiring the chronological project plan.
- Final lint, diff-integrity, and required CI checks pass on the Phase 12 branch.

## 6. Project Skills (Claude Code)

To keep documentation, testing rigor, and cost/security hygiene consistent across
every work session instead of relying on memory, the project uses Claude Code
Skills — folders under `.claude/skills/` containing a `SKILL.md` (YAML frontmatter
+ instructions) that Claude loads automatically when the current task matches the
skill's description. These are model-invoked, not something you run manually each
time.

| Skill | Triggers on | Maintains |
|---|---|---|
| **decision-log** | Any architectural choice with a real alternative (signing algo, Redis vs. DB-only, fixed vs. sliding window, ElastiCache vs. sidecar) | `DECISIONS.md` — ADR-format entries: context → options considered → decision → tradeoffs → revisit condition |
| **performance-log** | After any load test run; before/after Phase 5 or 6 changes | `PERFORMANCE.md` — dated, commit-hashed table of p50/p95/p99/throughput per scenario, kept comparable across runs |
| **test-coverage-guard** | Any new route, verifier check, or deny-reason added | Ensures a matching test exists in the established deny-reason taxonomy before considering the task done |
| **api-contract-sync** | Any change to a route's request/response shape | `API_REFERENCE.md` stays in sync with actual route code, so the README's token schema table never silently drifts from reality |
| **security-checklist** | Before any commit touching auth/signing/secrets | No plaintext keys/secrets, signing alg still asymmetric, TTL/scope defaults haven't quietly loosened, no full-token logging |
| **cost-guard** | Before/after any Terraform apply | `COST_LOG.md` — which AWS resources exist, approximate hourly cost, reminder to `terraform destroy` after a session |
| **readme-drift-check** | Before marking a phase "done" | Diffs README's claimed features/test-case table against what's actually implemented |
| **runbook-writer** | After any real dev-time incident (Redis down, ECS crash-loop, IAM denial) | `RUNBOOK.md` — what broke, why, how it was fixed; strong interview material |

**Priority pair:** `decision-log` and `performance-log` — these directly back the
Phase 5/6/7 discussion points (consistency, staleness, throughput) with real
artifacts instead of assertions, and are the two most likely to actually get used
under time pressure. The rest are valuable hygiene but can be added incrementally.

### Skills folder structure

```
agent-cred/
├── .claude/
│   └── skills/
│       ├── decision-log/SKILL.md
│       ├── performance-log/SKILL.md
│       ├── test-coverage-guard/SKILL.md
│       ├── api-contract-sync/SKILL.md
│       ├── security-checklist/SKILL.md
│       ├── cost-guard/SKILL.md
│       ├── readme-drift-check/SKILL.md
│       └── runbook-writer/SKILL.md
├── DECISIONS.md
├── PERFORMANCE.md
├── API_REFERENCE.md
├── COST_LOG.md
├── RUNBOOK.md
└── ... (rest of structure as above)
```

`decision-log` and `performance-log` are fully drafted and ready to drop in as-is;
the rest are scoped above and can be written in the same ADR-lite style when time
allows.


## 7. Total Time Estimate

| Phase | Hours |
|---|---|
| 0 — Setup | 1-2 |
| 1 — Issuer | 4-6 |
| 2 — Verifier SDK | 4-6 |
| 3 — Demo agents | 4-6 |
| 4 — Audit log + revocation | 3-5 |
| 5 — Distributed revocation cache | 5-7 |
| 6 — Rate limiting per credential | 4-6 |
| 7 — Simple load test | 2-3 |
| 8 — Dockerization | 1-2 |
| 9 — CI | 2 |
| 10 — Terraform | 4-6 |
| 11 — CD | 2-3 |
| 12 — README | 2-4 |
| **Total** | **~39-58h** |
| Debugging buffer (IAM/networking/Redis config, always underestimated) | +4-7 |

**Scoping note:** Phases 5-7 add ~11-16h on top of the original plan. If time is
tight, Phase 6 (rate limiting) is the safer cut than Phase 5 (revocation cache) —
the cache/consistency story is the stronger, more distinctive interview signal of
the two. Don't cut both; that removes the entire "systems thinking" layer that
differentiates this from the original v1 plan.

## 8. Specific Requirements / Non-Negotiables

- **Asymmetric signing (ES256), not shared secret** — mirrors cross-organizational trust in real systems; a core talking point.
- **`aud` claim enforced, not optional** — invocation-bound, not a bearer token usable anywhere.
- **Revocation checked before TTL expiry** — the specific known gap you're addressing; don't skip this even under time pressure.
- **All 6 verifier test cases must exist and pass** before moving to demo agents — this is the credibility core of the whole project.
- **Redis fallback must fail-safe, not fail-open** — if Redis is unreachable, the verifier falls back to Postgres for revocation checks; it must never treat "cache unavailable" as "not revoked."
- **The staleness-window demo (Phase 5) must produce an actual recorded number** (e.g., "5s sync interval → up to 5s stale-allow window") — this is the single most quotable line from the whole project; don't skip capturing it.
- **Rate limiting must be keyed by `principal:scope`, not `jti`** — keying by token ID alone allows trivial evasion via re-issuance and defeats the point of the feature.
- **Terraform kept small and fully explainable** — resist the urge to add modules/environments "to be safe." Simplicity you can defend beats scope you can't.
- **Cost control** — `terraform destroy` after each work session; RDS db.t4g.micro only; no NAT gateway if avoidable (adds ongoing cost) — use public subnets with tight security groups for this demo-scale project, and say so explicitly in the README as a known simplification.
- **Don't let this dilute your resume** — position as your AI-infra/LLMOps differentiator project, not a fourth generic project. If resume space is tight, it should replace a weaker existing bullet, not just add volume.
