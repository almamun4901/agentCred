# Architecture Decisions

This log records choices that affect implementation, operations, security, or future
work. Entries are append-only in spirit: if a choice changes, add a superseding ADR
instead of erasing the original context.

## ADR-0001: Use pnpm workspaces

- **Date:** 2026-07-17
- **Status:** Accepted
- **Context:** The issuer, verifier SDK, and demo agents need independent package
  boundaries while sharing one repository and TypeScript baseline.
- **Decision:** Use pnpm 10 with explicit workspace entries for `issuer`,
  `verifier-sdk`, and `demo-agents/*`; pin the package-manager version in the root
  manifest and commit the lockfile.
- **Tradeoffs:** pnpm is fast and strict about dependency boundaries, but contributors
  need pnpm/Corepack rather than npm alone. Keeping both the root `workspaces` field and
  `pnpm-workspace.yaml` provides tool compatibility at the cost of duplicated workspace
  declarations that must stay synchronized.

## ADR-0002: Run local PostgreSQL through Docker Compose

- **Date:** 2026-07-17
- **Status:** Accepted
- **Context:** Local development needs a reproducible database without requiring a
  host PostgreSQL installation.
- **Decision:** Use `postgres:17-alpine`, a named volume, a readiness health check,
  and automatic first-boot schema initialization.
- **Tradeoffs:** Compose makes onboarding and CI-like testing predictable, but it
  requires Docker and consumes local resources. Pinning the major version prevents
  accidental major upgrades while still accepting compatible minor and Alpine image
  updates. Exact image digests may be pinned later for deployment reproducibility.

## ADR-0003: Keep the development database local-only

- **Date:** 2026-07-17
- **Status:** Accepted
- **Context:** Phase 0 needs zero-config local startup, but the project handles
  security-sensitive credential metadata.
- **Decision:** Bind PostgreSQL to `127.0.0.1`, provide an explicitly local-only
  default password, and allow password and port overrides.
- **Tradeoffs:** A default credential improves local onboarding but must never be used
  in a deployed environment. Production credentials remain out of source control and
  will be supplied through AWS Secrets Manager or SSM.

## ADR-0004: Optimize the initial schema for credential-path correctness

- **Date:** 2026-07-17
- **Status:** Accepted
- **Context:** The schema must support issuance, revocation, and audit work in later
  phases without prematurely adding all future policy features.
- **Decision:**
  - Store `jti` as text rather than UUID so valid identifiers from other issuers are
    not artificially rejected.
  - Store scope as a non-empty PostgreSQL text array, matching the JWT scope list.
  - Store delegation chains and event metadata as validated JSONB for flexible claims.
  - Make revocations reference issuances, while leaving audit-log `jti` without a
    foreign key so malformed, unknown, and tampered token attempts can still be logged.
  - Enforce expiry ordering, allowed decisions, and denial-reason consistency with
    database constraints, not application code alone.
- **Tradeoffs:** Arrays and JSONB minimize mapping code and allow the token contract to
  evolve, but are less normalized and make some analytics harder. If scope-level policy
  queries become central, a normalized grant table may supersede the array design.
  Cascading issuance deletion removes its revocation, which is convenient locally but
  means production retention policy must avoid deleting security evidence casually.

## ADR-0005: Defer migrations until schema evolution begins

- **Date:** 2026-07-17
- **Status:** Accepted for Phase 0
- **Context:** Docker's initialization directory runs SQL only for a new empty volume.
- **Decision:** Use `db/schema.sql` for the initial local database and provide an
  explicit destructive `db:reset` command for recreating development state.
- **Tradeoffs:** This is simple and sufficient before application data exists, but it
  cannot safely upgrade persistent shared databases. Introduce versioned migrations
  before the first non-local environment or the first schema change that must preserve
  data, whichever comes first.

## ADR-0006: Store development signing keys as local PEM files

- **Date:** 2026-07-17
- **Status:** Accepted for local development
- **Context:** Phase 1 needs repeatable asymmetric signing without introducing cloud
  infrastructure or committing credential material.
- **Options considered:** Local PEM files generated on demand; an environment variable
  containing the private key; or managed KMS/secret storage immediately.
- **Decision:** Generate an ES256 PKCS#8 private key and SPKI public key under the
  gitignored `issuer/keys/` directory. The private file is owner-readable only and is
  loaded once at startup.
- **Tradeoffs:** This is simple and makes public-key inspection easy, but rotation and
  distribution are manual. Environment variables avoid a file but are easier to leak
  through process configuration. Managed storage is the deployment target, but would
  add infrastructure before the issuer contract is proven.
- **Revisit if:** The issuer is deployed, shared by multiple developers, or needs key
  rotation without a restart.

## ADR-0007: Keep Phase 1 issuance local-only with a one-hour TTL ceiling

- **Date:** 2026-07-17
- **Status:** Accepted for Phase 1
- **Context:** The demo needs a convenient issuance endpoint, while an unauthenticated
  public issuer would let arbitrary callers mint credentials.
- **Options considered:** Unauthenticated local endpoint; shared API key; or
  principal-specific caller authentication.
- **Decision:** Bind the issuer to loopback, leave `POST /issue` unauthenticated for
  Phase 1, and accept integer TTLs from 1 through 3600 seconds.
- **Tradeoffs:** This keeps the phase focused and limits bearer-token lifetime, but it
  is unsafe to expose publicly and requires frequent reissuance. Caller authentication
  remains mandatory before deployment.
- **Revisit if:** The issuer is exposed outside a trusted local environment or the demo
  needs a longer credential lifecycle.

## ADR-0008: Sign before persistence and release only persisted credentials

- **Date:** 2026-07-17
- **Status:** Accepted
- **Context:** JWT claims and database metadata must agree exactly, and clients should
  not receive credentials absent from the issuer's audit source of truth.
- **Options considered:** Insert then sign; sign then insert and return immediately; or
  sign, insert the exact claims, and return only after the insert succeeds.
- **Decision:** Finalize and sign claims first, persist those exact values second, and
  return the bearer token only after PostgreSQL accepts the issuance.
- **Tradeoffs:** Claim values cannot drift from the database and every returned token
  has an issuance row. A database failure discards a valid in-memory signature, which
  is harmless but consumes signing work. UUID collisions surface as insert failures
  rather than being retried because their practical probability is negligible.
- **Revisit if:** Signing moves to a metered remote KMS or issuance throughput makes
  discarded signing operations operationally meaningful.

## ADR-0009: Inject revocation checks into a fail-closed verifier

- **Date:** 2026-07-18
- **Status:** Accepted
- **Context:** Credential verification combines deterministic cryptographic and scope
  checks with a stateful revocation lookup. A direct PostgreSQL dependency in the core
  verifier would make testing harder and force a rewrite when Redis is introduced.
- **Options considered:** Query PostgreSQL directly inside verification; defer real
  revocation behavior; or inject an asynchronous `isRevoked(jti)` capability.
- **Decision:** Configure a reusable verifier with its public key, trusted issuer, and
  injected revocation checker. Provide PostgreSQL as the Phase 2 adapter, fail closed
  with `verification_unavailable` on lookup errors, and evaluate revocation before
  scope. Accept only ES256 tokens and exact, case-sensitive scope matches.
- **Tradeoffs:** Dependency injection adds a factory and one interface, but isolates
  storage, enables deterministic tests, and lets Phase 5 introduce Redis without
  changing the credential decision path. Failing closed preserves authorization
  safety during an outage but reduces availability until revocation reads recover.
- **Revisit if:** Availability requirements demand a bounded-staleness fallback policy,
  issuer key rotation requires a JWKS resolver, or scope semantics expand beyond exact
  string membership.

## ADR-0010: Observe authorization synchronously but fail open on audit errors

- **Date:** 2026-07-20
- **Status:** Accepted for Phase 3
- **Context:** The overreach demo needs durable, trusted evidence for both its denied
  and allowed calls. Logging only in Agent B would duplicate verifier logic, while
  fire-and-forget logging could let the demo finish before its evidence is stored.
- **Options considered:** Await and fail closed; await and preserve the authorization
  outcome; or enqueue/fire-and-forget the audit event.
- **Decision:** Add a typed decision observer to the verifier. Finalize the immutable
  authorization result before awaiting observation. Agent B inserts the event,
  retries once after 100 ms, and logs a structured error after the second failure.
  Observer and error-handler exceptions are contained and never change the finalized
  result.
- **Tradeoffs:** Awaiting the insert adds a PostgreSQL round trip and a visible retry
  delay during failure, but tightly correlates the response with durable evidence.
  Preserving the result protects availability but permits explicit audit gaps and is
  not sufficient for every compliance threat model. Fire-and-forget would reduce
  latency; fail-closed auditing would provide stronger completeness guarantees.
- **Revisit if:** Audit completeness becomes mandatory, request latency requires an
  outbox/queue, or delivery needs idempotency and stronger retry guarantees. When
  Phase 5 puts Redis on Agent B's request path, extend its startup readiness check to
  Redis rather than silently retaining a PostgreSQL-only probe.

## ADR-0011: Make revocation idempotent and first-write-wins

- **Date:** 2026-07-20
- **Status:** Accepted for Phase 4
- **Context:** Operators and automated clients must be able to retry a revocation
  safely without making security evidence mutable. The existing schema permits only
  locally issued JTIs and already stores an optional reason and database timestamp.
- **Options considered:** Reject duplicates with `409`; update the reason on every
  request; or return the original revocation for both the initial call and retries.
- **Decision:** Keep `POST /revoke`, require a locally stored JTI, and use one atomic
  `INSERT ... SELECT ... ON CONFLICT` statement. Return `200` with the stored row for
  both first writes and duplicates, preserve the first timestamp and reason, return
  `404` for unknown issuances, and permit revocation after credential expiry.
- **Tradeoffs:** Stable idempotency makes network retries simple and retains immutable
  evidence, but callers cannot edit an incorrect reason and the endpoint cannot
  preemptively revoke a JTI unknown to this issuer. The conflict path performs a
  no-semantic-change update so concurrent requests can reliably return the winning
  row in one PostgreSQL statement.
- **Revisit if:** Federated issuers require unknown-JTI revocation, evidence correction
  needs an append-only annotation model, or the endpoint is exposed beyond loopback
  and therefore requires operator authentication and authorization.

## ADR-0012: Trust Redis misses only under a bounded freshness lease

- **Date:** 2026-07-21
- **Status:** Accepted for Phase 5
- **Context:** Falling back to PostgreSQL on every Redis miss would leave the database
  on the normal path for every valid credential and make the cache ineffective. Trusting
  an unqualified miss could silently allow revoked credentials after the synchronizer
  or Redis state becomes unhealthy.
- **Options considered:** Query PostgreSQL after every miss; trust all Redis misses; or
  trust misses only while a synchronizer-maintained freshness key is live.
- **Decision:** Store each revoked JTI under an individual key expiring exactly with
  its credential. A successful full sync refreshes a freshness key for three sync
  intervals. Agent B treats a healthy, fresh miss as not revoked, but falls back to
  PostgreSQL on Redis errors, malformed values, or a missing freshness key. The issuer
  writes through after committing PostgreSQL and returns a retryable `503` if Redis
  propagation fails. Out-of-band writes remain eventually consistent within the
  configured sync interval.
- **Tradeoffs:** Normal checks use one Redis round trip and cache failure remains safe,
  but a directly inserted revocation can be allowed until the next sync. The live
  five-second walkthrough observed its final stale allow 4.923 seconds after the
  database write and its first denial after 5.029 seconds, including 100 ms polling
  resolution. Full active-set synchronization is simple and robust at demo scale but
  is not the final strategy for a large revocation table.
- **Revisit if:** The revocation set requires incremental or event-driven propagation,
  the stale-allow budget approaches zero, multiple issuer replicas require singleton
  scheduling, or PostgreSQL fallback availability is no longer acceptable.

## ADR-0013: Enforce exact principal/action budgets with an atomic Redis fixed window

- **Date:** 2026-07-21
- **Status:** Accepted for Phase 6
- **Context:** A JTI-keyed budget can be bypassed by issuing a new credential, while a
  limit embedded in a JWT cannot be changed until that credential expires.
- **Options considered:** Put limits in JWT claims; store policies in PostgreSQL; use
  fixed, sliding, or token-bucket counters; and key counters by JTI or trusted identity.
- **Decision:** Store exact policies in PostgreSQL by principal, audience, and scope.
  A missing policy means unlimited access. After signature, revocation, and exact scope
  checks, run an atomic Redis Lua fixed-window operation keyed by those three trusted
  dimensions. Use Redis server time, allow exactly `max_requests`, do not increment
  denied attempts, expire counters after their window, and fail closed if either the
  policy lookup or Redis operation fails. Return HTTP 429 with `Retry-After` and audit
  the distinct `deny_rate_limited` decision.
- **Tradeoffs:** Token rotation cannot reset a budget and concurrent Agent B replicas
  share one counter, but fixed windows permit boundary bursts. PostgreSQL policy lookup
  remains on the limited-request path so changes apply immediately; Phase 7 must measure
  that cost before a policy cache is justified. Scope is checked before rate limiting
  so an out-of-scope credential cannot drain another action's legitimate capacity.
- **Revisit if:** Load evidence justifies a bounded-stale policy cache, fairness needs a
  sliding window or token bucket, wildcard policy precedence is required, or Redis
  cluster deployment requires a different script/key strategy.

## ADR-0014: Use immutable non-root images and volume-initialized local keys

- **Date:** 2026-07-21
- **Status:** Accepted for Phase 8
- **Context:** The local demo must start from a clean clone without host-generated
  keys, while the resulting application images should remain usable as the baseline
  for ECS. Agent B needs the public key but must never receive the issuer's private
  key.
- **Options considered:** Host-generated bind-mounted keys; keys committed or baked
  into an image; one shared key volume; or an initialization service with isolated
  volumes. Development containers with source mounts were also considered instead of
  immutable production-style images.
- **Decision:** Build compiled, production-dependency-only images for issuer, Agent B,
  and one-shot Agent A from a digest-pinned Node 22 Alpine base. Run applications as
  UID 10001 with read-only root filesystems,
  dropped capabilities, health checks, and graceful signal handling. A root-only local
  initializer creates or validates an ES256 pair in two named volumes: issuer mounts
  the private volume and Agent B mounts only the public volume. Compose runs Agent A
  only through the `demo` profile and health-gates it on both application services.
- **Tradeoffs:** Multi-stage workspace builds duplicate some build work across images,
  and the key initializer adds lifecycle complexity. Named volumes give a true
  one-command local startup and stable restarts, but they are local secret storage—not
  a production secret-management design. Separate volumes prevent accidental private
  key disclosure to Agent B at the cost of an extra volume and explicit initialization.
- **Revisit if:** Phase 11 uses separate repositories or a shared build pipeline,
  production signing moves to KMS, ECS injects keys from Secrets Manager, key rotation
  requires overlapping verification keys/JWKS, or image-size evidence justifies a
  different workspace packaging strategy.
