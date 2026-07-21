import { describe, expect, it, vi } from "vitest";
import {
  REVOCATION_FRESHNESS_KEY,
  cacheRevocation,
  createRedisRevocationChecker,
  revocationCacheKey,
} from "../src/revocation-cache.js";

describe("Redis revocation cache", () => {
  it("returns true for a cached revocation without querying PostgreSQL", async () => {
    const fallback = vi.fn(async () => false);
    const redis = { mGet: vi.fn(async () => ["2026-07-21T15:00:00.000Z", "1"]) };
    const isRevoked = createRedisRevocationChecker({ redis, fallback });

    await expect(isRevoked("known-jti")).resolves.toBe(true);
    expect(redis.mGet).toHaveBeenCalledWith([
      REVOCATION_FRESHNESS_KEY,
      revocationCacheKey("known-jti"),
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("trusts a healthy cache miss without querying PostgreSQL", async () => {
    const fallback = vi.fn(async () => true);
    const isRevoked = createRedisRevocationChecker({
      redis: { mGet: vi.fn(async () => ["2026-07-21T15:00:00.000Z", null]) },
      fallback,
    });

    await expect(isRevoked("not-revoked")).resolves.toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([
    ["missing freshness", [null, null]],
    ["blank freshness", ["", null]],
    ["malformed freshness", ["not-a-timestamp", null]],
    ["malformed revocation", ["2026-07-21T15:00:00.000Z", "unexpected"]],
    ["malformed response", ["2026-07-21T15:00:00.000Z"]],
  ])("falls back for %s", async (_name, response) => {
    const fallback = vi.fn(async () => true);
    const isRevoked = createRedisRevocationChecker({
      redis: { mGet: vi.fn(async () => response) },
      fallback,
    });

    await expect(isRevoked("fallback-jti")).resolves.toBe(true);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back when Redis is unavailable and propagates fallback failure", async () => {
    const redis = { mGet: vi.fn().mockRejectedValue(new Error("redis unavailable")) };
    const postgresError = new Error("postgres unavailable");
    const fallback = vi.fn().mockRejectedValue(postgresError);
    const isRevoked = createRedisRevocationChecker({ redis, fallback });

    await expect(isRevoked("unavailable-jti")).rejects.toBe(postgresError);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("writes a revocation with an absolute expiry matching the credential", async () => {
    const redis = { set: vi.fn(async () => "OK") };
    const expiresAt = new Date("2026-07-21T15:30:45.000Z");

    await expect(
      cacheRevocation(
        redis,
        { jti: "expiring-jti", expiresAt },
        new Date("2026-07-21T15:00:00.000Z"),
      ),
    ).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(revocationCacheKey("expiring-jti"), "1", {
      expiration: { type: "EXAT", value: 1_784_647_845 },
    });
  });

  it("skips credentials that have already expired", async () => {
    const redis = { set: vi.fn(async () => "OK") };
    await expect(
      cacheRevocation(
        redis,
        { jti: "expired-jti", expiresAt: new Date("2026-07-21T14:59:59Z") },
        new Date("2026-07-21T15:00:00Z"),
      ),
    ).resolves.toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
