import { randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresRevocationChecker } from "../src/revocation.js";
import { createCredentialVerifier } from "../src/verify.js";

const { Pool } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
const pool = new Pool({ connectionString: databaseUrl });

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL revocation verification", () => {
  it("denies a signed credential after its JTI is revoked", async () => {
    const jti = `verifier-integration-${randomUUID()}`;
    const now = Math.floor(Date.now() / 1_000);
    const { privateKey, publicKey } = await generateKeyPair("ES256");

    try {
      await pool.query(
        `INSERT INTO issuances (
          jti, agent_id, principal, scope, audience, issued_at, expires_at, delegation_chain
        ) VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8::jsonb)`,
        [
          jti,
          "agent-a",
          "company-x",
          ["read:weather"],
          "agent-b",
          now,
          now + 300,
          "[]",
        ],
      );

      const token = await new SignJWT({
        principal: "company-x",
        scope: ["read:weather"],
        delegation_chain: [],
      })
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setIssuer("test-issuer")
        .setSubject("agent-a")
        .setAudience("agent-b")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .setJti(jti)
        .sign(privateKey);
      const isRevoked = createPostgresRevocationChecker(pool);
      const verifyCredential = createCredentialVerifier({
        publicKey,
        issuer: "test-issuer",
        isRevoked,
      });

      await expect(isRevoked(jti)).resolves.toBe(false);
      await pool.query("INSERT INTO revocations (jti, reason) VALUES ($1, $2)", [
        jti,
        "integration test",
      ]);
      await expect(isRevoked(jti)).resolves.toBe(true);
      await expect(
        verifyCredential(token, "read:weather", "agent-b"),
      ).resolves.toEqual({ decision: "deny", reason: "revoked" });
    } finally {
      await pool.query("DELETE FROM issuances WHERE jti = $1", [jti]);
    }
  });
});
