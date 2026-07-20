# API Reference

## Issuer configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred` | PostgreSQL connection string |
| `SIGNING_PRIVATE_KEY_PATH` | `keys/private.pem` | ES256 PKCS#8 private-key path, resolved from the issuer process directory |
| `ISSUER_ID` | `agentcred-issuer` | Value written to the JWT `iss` claim |
| `PORT` | `3000` | Loopback-only HTTP port |

The Phase 1 issuer is an unauthenticated local-development service. Do not expose it
to an untrusted network.

## POST /issue

Creates and stores a scoped credential. The response is not sent until the issuance
row has been committed to PostgreSQL.

**Request body:**

| Field | Type | Required | Validation |
|---|---|---|---|
| `agent_id` | string | yes | non-blank; becomes JWT `sub` |
| `principal` | string | yes | non-blank |
| `scope` | string[] | yes | non-empty, unique, non-blank entries |
| `aud` | string | yes | non-blank intended audience |
| `ttl` | integer | yes | seconds from 1 through 3600 |

Example:

```json
{
  "agent_id": "agent-a",
  "principal": "company-x",
  "scope": ["read:weather"],
  "aud": "agent-b",
  "ttl": 300
}
```

**Response — 200:**

```json
{ "token": "<signed-jwt>" }
```

**Response — 400:** malformed input.

```json
{ "error": "validation_error", "message": "<validation detail>" }
```

**Response — 500:** signing or persistence failure. Internal details are not returned.

```json
{ "error": "internal_server_error" }
```

## GET /issuances/:jti

Returns stored issuance metadata for local debugging. It never returns or reconstructs
the bearer token.

**Response — 200:**

```json
{
  "jti": "b3d62e1e-...",
  "agent_id": "agent-a",
  "principal": "company-x",
  "scope": ["read:weather"],
  "audience": "agent-b",
  "issued_at": "2026-07-17T06:00:00.000Z",
  "expires_at": "2026-07-17T06:05:00.000Z",
  "delegation_chain": []
}
```

**Response — 404:**

```json
{ "error": "issuance_not_found" }
```

## JWT contract

The protected header is `{ "alg": "ES256", "typ": "JWT" }`.

| Claim | Meaning |
|---|---|
| `iss` | configured issuer identifier |
| `sub` | requesting `agent_id` |
| `aud` | intended receiving service |
| `iat` | issuance time as Unix seconds |
| `exp` | exactly `iat + ttl` |
| `jti` | random UUID credential identifier |
| `principal` | identity on whose behalf the agent acts |
| `scope` | permitted action strings |
| `delegation_chain` | empty array in Phase 1 |

Last verified against code: 2026-07-17 (working tree before initial commit).

## Verifier SDK

The verifier is configured once with the issuer's ES256 public key, the exact trusted
issuer identifier, and an asynchronous revocation checker. The returned function is
safe to reuse across requests.

```ts
import { readFile } from "node:fs/promises";
import { importSPKI } from "jose";
import {
  createCredentialVerifier,
  createPostgresRevocationChecker,
} from "@agent-cred/verifier-sdk";

const publicKey = await importSPKI(
  await readFile("issuer/keys/public.pem", "utf8"),
  "ES256",
);
const verifyCredential = createCredentialVerifier({
  publicKey,
  issuer: "agentcred-issuer",
  isRevoked: createPostgresRevocationChecker(pool),
});

const result = await verifyCredential(token, "read:weather", "agent-b");
```

An allowed result contains only claims that passed signature and claim validation:

```ts
{ decision: "allow", claims: { /* verified credential claims */ } }
```

A denied result contains one stable reason and never exposes unverified claims or an
internal error:

| Reason | Meaning |
|---|---|
| `invalid_signature` | malformed token, tampering, wrong key, or disallowed algorithm |
| `expired` | `exp` is no longer valid |
| `issuer_mismatch` | `iss` is not the configured trusted issuer |
| `aud_mismatch` | `aud` is not the receiving service |
| `invalid_claims` | required claims or the JWT type have the wrong shape |
| `revoked` | the token's `jti` exists in the revocation source |
| `scope_exceeded` | the requested action is not an exact member of `scope` |
| `verification_unavailable` | the revocation source could not produce a decision |

Revocation is checked before scope. A revocation-source failure denies the request;
the verifier does not fail open.

### Fastify pre-handler

```ts
import { createVerifierPreHandler } from "@agent-cred/verifier-sdk";

app.get("/weather", {
  preHandler: createVerifierPreHandler({
    verifyCredential,
    requestedAction: "read:weather",
    expectedAudience: "agent-b",
  }),
}, async (request) => ({ principal: request.credential?.principal }));
```

The middleware accepts only an `Authorization: Bearer <token>` header. It returns
`401` for a missing or unusable credential, `403` for insufficient scope, and `503`
when revocation status cannot be checked. Error bodies use
`{ "error": "credential_denied", "reason": "..." }` and never include the token.

The PostgreSQL adapter owns no connection lifecycle; the consuming service creates
and closes its pool. Phase 4 adds revocation writes. Phase 5 may replace the injected
checker with Redis without changing the verifier API.

### Verification decision observer

Consumers may configure `onDecision` to synchronously observe a finalized decision.
Its readonly event contains `requestedAction`, `audience`, `decision`, and
`denialReason`. The `jti` and `principal` fields are populated only after signature
and required-claim validation; they remain null for untrusted credentials.

```ts
const verifyCredential = createCredentialVerifier({
  publicKey,
  issuer: "agentcred-issuer",
  isRevoked,
  onDecision: async (event) => persistAuditEvent(event),
  onDecisionError: (error, event) => logger.error({ error, event }),
});
```

The verifier finalizes its result before invoking the observer. Observer and
`onDecisionError` failures are contained and cannot replace or reject the original
authorization result. Because `onDecision` is awaited, consumers choose whether to
trade response latency for tighter correlation with durable audit evidence.

## Agent B configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local AgentCred PostgreSQL URL | Revocation reads, readiness, and audit writes |
| `VERIFYING_PUBLIC_KEY_PATH` | `../../issuer/keys/public.pem` | Issuer ES256 public key |
| `ISSUER_ID` | `agentcred-issuer` | Exact trusted JWT issuer |
| `AGENT_B_AUDIENCE` | `agent-b` | Exact accepted JWT audience |
| `PORT` | `3001` | Loopback-only HTTP port |

Agent B refuses to listen if PostgreSQL is unavailable.

## GET /get-quote

Requires `Authorization: Bearer <token>`, audience `agent-b`, and exact scope
`read:quote:basic`.

**Response — 200:**

```json
{
  "quote": "Trust is scoped, verified, and revocable.",
  "served_to": "<verified-principal>"
}
```

Insufficient scope returns `403` with `scope_exceeded`. Other credential errors use
the verifier middleware mappings documented above. Every credential verification is
written synchronously to `verification_log`; Agent B retries once after 100 ms and
logs a structured audit-gap error if both inserts fail without changing the HTTP
authorization result.

Last verified against code: 2026-07-20.
