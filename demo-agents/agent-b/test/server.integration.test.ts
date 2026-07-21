import { randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialVerifier,
  createPostgresRateLimitPolicyResolver,
  createPostgresRevocationChecker,
  createRedisRateLimiter,
  rateLimitKey,
} from "@agent-cred/verifier-sdk";
import { createPostgresAuditObserver } from "../src/audit.js";
import { buildServer } from "../src/server.js";

const { Pool } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("Agent B PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: redisUrl, disableOfflineQueue: true });
  const principal = `phase3-integration-${randomUUID()}`;
  const jtis = [`phase3-deny-${randomUUID()}`, `phase3-allow-${randomUUID()}`];
  let app: ReturnType<typeof buildServer>;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    await redis.connect();
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
    await pool.query(
      `INSERT INTO rate_limit_policies
         (principal, audience, scope, window_seconds, max_requests)
       VALUES ($1, 'agent-b', 'read:quote:basic', 60, 3)`,
      [principal],
    );
    app = buildServer({
      verifyCredential: createCredentialVerifier({
        publicKey: keys.publicKey,
        issuer: "integration-issuer",
        isRevoked: createPostgresRevocationChecker(pool),
        checkRateLimit: createRedisRateLimiter({
          redis,
          getPolicy: createPostgresRateLimitPolicyResolver(pool),
        }),
        onDecision: createPostgresAuditObserver(pool),
      }),
    });
  });

  afterAll(async () => {
    await app?.close();
    if (redis.isReady) {
      await redis.del(
        rateLimitKey({
          principal,
          audience: "agent-b",
          requestedAction: "read:quote:basic",
        }),
      );
      await redis.quit();
    }
    await pool.query("DELETE FROM verification_log WHERE principal = $1", [principal]);
    await pool.query("DELETE FROM rate_limit_policies WHERE principal = $1", [principal]);
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

  it("records scope denial, shared-token budget, and the rate-limit denial", async () => {
    const denied = await app.inject({
      method: "GET",
      url: "/get-quote",
      headers: { authorization: `Bearer ${await sign(jtis[0]!, ["read:weather"])}` },
    });
    const firstToken = await sign(jtis[1]!, ["read:quote:basic"]);
    const rotatedToken = await sign(`rotated-${randomUUID()}`, ["read:quote:basic"]);
    const responses = [];
    for (const credential of [firstToken, rotatedToken, firstToken, rotatedToken]) {
      responses.push(
        await app.inject({
          method: "GET",
          url: "/get-quote",
          headers: { authorization: `Bearer ${credential}` },
        }),
      );
    }

    expect(denied.statusCode).toBe(403);
    expect(responses.map((response) => response.statusCode)).toEqual([
      200,
      200,
      200,
      429,
    ]);
    expect(responses[3]?.headers["retry-after"]).toMatch(/^\d+$/);
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
      {
        jti: expect.stringMatching(/^rotated-/),
        requested_action: "read:quote:basic",
        audience: "agent-b",
        decision: "allow",
        denial_reason: null,
      },
      {
        jti: jtis[1],
        requested_action: "read:quote:basic",
        audience: "agent-b",
        decision: "allow",
        denial_reason: null,
      },
      {
        jti: expect.stringMatching(/^rotated-/),
        requested_action: "read:quote:basic",
        audience: "agent-b",
        decision: "deny_rate_limited",
        denial_reason: "rate_limited",
      },
    ]);
  });
});
