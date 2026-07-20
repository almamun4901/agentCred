import { randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialVerifier,
  createPostgresRevocationChecker,
} from "@agent-cred/verifier-sdk";
import { createPostgresAuditObserver } from "../src/audit.js";
import { buildServer } from "../src/server.js";

const { Pool } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";

describe("Agent B PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const principal = `phase3-integration-${randomUUID()}`;
  const jtis = [`phase3-deny-${randomUUID()}`, `phase3-allow-${randomUUID()}`];
  let app: ReturnType<typeof buildServer>;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const keys = await generateKeyPair("ES256");
    privateKey = keys.privateKey;
    const now = new Date();
    const expires = new Date(now.getTime() + 300_000);
    for (const [index, jti] of jtis.entries()) {
      await pool.query(
        `INSERT INTO issuances (
          jti, agent_id, principal, scope, audience, issued_at, expires_at
        ) VALUES ($1, 'agent-a', $2, $3, 'agent-b', $4, $5)`,
        [
          jti,
          principal,
          index === 0 ? ["read:weather"] : ["read:quote:basic"],
          now,
          expires,
        ],
      );
    }
    app = buildServer({
      verifyCredential: createCredentialVerifier({
        publicKey: keys.publicKey,
        issuer: "integration-issuer",
        isRevoked: createPostgresRevocationChecker(pool),
        onDecision: createPostgresAuditObserver(pool),
      }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool.query("DELETE FROM verification_log WHERE principal = $1", [principal]);
    await pool.query("DELETE FROM issuances WHERE jti = ANY($1::text[])", [jtis]);
    await pool.end();
  });

  async function sign(jti: string, scope: string[]): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({ principal, scope, delegation_chain: [] })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer("integration-issuer")
      .setSubject("agent-a")
      .setAudience("agent-b")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(jti)
      .sign(privateKey);
  }

  it("records one scope denial followed by one allow", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/get-quote",
      headers: { authorization: `Bearer ${await sign(jtis[0]!, ["read:weather"])}` },
    });
    const allowed = await app.inject({
      method: "GET",
      url: "/get-quote",
      headers: {
        authorization: `Bearer ${await sign(jtis[1]!, ["read:quote:basic"])}`,
      },
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    const rows = await pool.query(
      `SELECT jti, requested_action, audience, decision, denial_reason
       FROM verification_log
       WHERE principal = $1
       ORDER BY id`,
      [principal],
    );
    expect(rows.rows).toEqual([
      {
        jti: jtis[0],
        requested_action: "read:quote:basic",
        audience: "agent-b",
        decision: "deny",
        denial_reason: "scope_exceeded",
      },
      {
        jti: jtis[1],
        requested_action: "read:quote:basic",
        audience: "agent-b",
        decision: "allow",
        denial_reason: null,
      },
    ]);
  });
});
