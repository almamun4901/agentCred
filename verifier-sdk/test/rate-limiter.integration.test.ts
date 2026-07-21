import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresRateLimitPolicyResolver,
  createRedisRateLimiter,
  rateLimitKey,
} from "../src/rate-limiter.js";

const { Pool } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("Redis rate limiting", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: redisUrl, disableOfflineQueue: true });
  const principal = `phase6-integration-${randomUUID()}`;
  const context = {
    principal,
    audience: "agent-b",
    requestedAction: "read:quote:basic",
  };

  beforeAll(async () => {
    await redis.connect();
    await pool.query(
      `INSERT INTO rate_limit_policies
         (principal, audience, scope, window_seconds, max_requests)
       VALUES ($1, $2, $3, 60, 3)`,
      [principal, context.audience, context.requestedAction],
    );
  });

  afterAll(async () => {
    if (redis.isReady) {
      await redis.del(rateLimitKey(context));
      await redis.quit();
    } else if (redis.isOpen) {
      redis.destroy();
    }
    await pool.query("DELETE FROM rate_limit_policies WHERE principal = $1", [
      principal,
    ]);
    await pool.end();
  });

  it("atomically permits exactly three concurrent requests", async () => {
    const limiter = createRedisRateLimiter({
      redis,
      getPolicy: createPostgresRateLimitPolicyResolver(pool),
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => limiter(context)),
    );
    expect(results.filter((result) => !result.limited)).toHaveLength(3);
    expect(results.filter((result) => result.limited)).toHaveLength(9);

    const count = await redis.hGet(rateLimitKey(context), "count");
    expect(count).toBe("3");
    const ttl = await redis.ttl(rateLimitKey(context));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(61);
  });

  it("isolates principals and allows again after the window resets", async () => {
    const principals = [`reset-a-${randomUUID()}`, `reset-b-${randomUUID()}`];
    const contexts = principals.map((isolatedPrincipal) => ({
      ...context,
      principal: isolatedPrincipal,
    }));
    try {
      for (const isolatedPrincipal of principals) {
        await pool.query(
          `INSERT INTO rate_limit_policies
             (principal, audience, scope, window_seconds, max_requests)
           VALUES ($1, $2, $3, 1, 1)`,
          [isolatedPrincipal, context.audience, context.requestedAction],
        );
      }
      const limiter = createRedisRateLimiter({
        redis,
        getPolicy: createPostgresRateLimitPolicyResolver(pool),
      });

      await expect(limiter(contexts[0]!)).resolves.toMatchObject({ limited: false });
      await expect(limiter(contexts[1]!)).resolves.toMatchObject({ limited: false });
      let denied = await limiter(contexts[0]!);
      if (!denied.limited) {
        denied = await limiter(contexts[0]!);
      }
      expect(denied.limited).toBe(true);
      if (!denied.limited) {
        throw new Error("Expected the isolated principal to be rate limited");
      }

      await new Promise((resolve) =>
        setTimeout(resolve, denied.retryAfterSeconds * 1_000 + 100),
      );
      await expect(limiter(contexts[0]!)).resolves.toMatchObject({ limited: false });
    } finally {
      await Promise.all(contexts.map((item) => redis.del(rateLimitKey(item))));
      await pool.query("DELETE FROM rate_limit_policies WHERE principal = ANY($1)", [
        principals,
      ]);
    }
  });
});
