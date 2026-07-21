import { randomUUID } from "node:crypto";
import { generateKeyPair, jwtVerify } from "jose";
import pg from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REVOCATION_FRESHNESS_KEY,
  cacheRevocation,
  createCredentialVerifier,
  createPostgresRevocationChecker,
  createRedisRevocationChecker,
  revocationCacheKey,
} from "@agent-cred/verifier-sdk";
import {
  createIssuanceRepository,
  createRevocationSyncRepository,
} from "../src/db.js";
import { createRevocationSynchronizer } from "../src/jobs/sync-revocations.js";
import { buildServer } from "../src/server.js";
import { createCredentialSigner } from "../src/sign.js";

const { Pool } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("distributed revocation cache", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: redisUrl });
  const jtis: string[] = [];
  let app: ReturnType<typeof buildServer>;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    await redis.connect();
    const keys = await generateKeyPair("ES256");
    publicKey = keys.publicKey;
    app = buildServer({
      repository: createIssuanceRepository(pool),
      publishRevocation: async (revocation) => {
        await cacheRevocation(redis, {
          jti: revocation.jti,
          expiresAt: revocation.expires_at,
        });
      },
      signCredential: createCredentialSigner({
        issuer: "phase5-integration-issuer",
        privateKey: keys.privateKey,
      }),
    });
  });

  afterAll(async () => {
    if (jtis.length > 0) {
      await redis.del(jtis.map(revocationCacheKey));
      await pool.query("DELETE FROM verification_log WHERE jti = ANY($1::text[])", [
        jtis,
      ]);
      await pool.query("DELETE FROM issuances WHERE jti = ANY($1::text[])", [jtis]);
    }
    await redis.del(REVOCATION_FRESHNESS_KEY);
    await app?.close();
    await redis.quit();
    await pool.end();
  });

  function createSynchronizer(intervalSeconds = 1) {
    return createRevocationSynchronizer({
      repository: createRevocationSyncRepository(pool),
      redis,
      intervalSeconds,
      logger: { info() {}, error() {} },
    });
  }

  async function issue(): Promise<{ jti: string; token: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/issue",
      payload: {
        agent_id: "agent-a",
        principal: `phase5-${randomUUID()}`,
        scope: ["read:quote:basic"],
        aud: "agent-b",
        ttl: 300,
      },
    });
    expect(response.statusCode).toBe(200);
    const { token } = response.json<{ token: string }>();
    const claims = await jwtVerify(token, publicKey, {
      algorithms: ["ES256"],
      issuer: "phase5-integration-issuer",
      audience: "agent-b",
    });
    const jti = claims.payload.jti!;
    jtis.push(jti);
    return { jti, token };
  }

  function verifier() {
    return createCredentialVerifier({
      publicKey,
      issuer: "phase5-integration-issuer",
      isRevoked: createRedisRevocationChecker({
        redis,
        fallback: createPostgresRevocationChecker(pool),
      }),
    });
  }

  it("denies immediately after API write-through", async () => {
    await createSynchronizer().syncOnce();
    const { jti, token } = await issue();
    const verify = verifier();

    await expect(verify(token, "read:quote:basic", "agent-b")).resolves.toMatchObject({
      decision: "allow",
    });
    const response = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti, reason: "fast path integration" },
    });
    expect(response.statusCode).toBe(200);
    await expect(verify(token, "read:quote:basic", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "revoked",
    });
    await expect(redis.ttl(revocationCacheKey(jti))).resolves.toBeGreaterThan(0);
    await expect(redis.ttl(revocationCacheKey(jti))).resolves.toBeLessThanOrEqual(300);
  });

  it("shows a bounded stale allow before periodic synchronization", async () => {
    await createSynchronizer().syncOnce();
    const { jti, token } = await issue();
    const verify = verifier();
    await pool.query("INSERT INTO revocations (jti, reason) VALUES ($1, $2)", [
      jti,
      "out-of-band integration",
    ]);

    await expect(verify(token, "read:quote:basic", "agent-b")).resolves.toMatchObject({
      decision: "allow",
    });

    const synchronizer = createSynchronizer(1);
    const startedAt = Date.now();
    synchronizer.start();
    try {
      await expect.poll(
        () => verify(token, "read:quote:basic", "agent-b"),
        { interval: 50, timeout: 1_600 },
      ).toEqual({ decision: "deny", reason: "revoked" });
      expect(Date.now() - startedAt).toBeLessThanOrEqual(1_600);
    } finally {
      synchronizer.stop();
    }
  });

  it("falls back to PostgreSQL when Redis is unavailable", async () => {
    const { jti, token } = await issue();
    await pool.query("INSERT INTO revocations (jti, reason) VALUES ($1, $2)", [
      jti,
      "fallback integration",
    ]);
    const verify = createCredentialVerifier({
      publicKey,
      issuer: "phase5-integration-issuer",
      isRevoked: createRedisRevocationChecker({
        redis: { mGet: async () => Promise.reject(new Error("redis unavailable")) },
        fallback: createPostgresRevocationChecker(pool),
      }),
    });

    await expect(verify(token, "read:quote:basic", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "revoked",
    });
  });
});
