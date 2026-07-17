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
