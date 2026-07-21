import { describe, expect, it, vi } from "vitest";
import {
  createPostgresRateLimitPolicyResolver,
  createRedisRateLimiter,
  rateLimitKey,
  type GetRateLimitPolicy,
  type RateLimitRedisClient,
} from "../src/rate-limiter.js";

const context = {
  principal: "company:x",
  audience: "agent-b",
  requestedAction: "read:quote:basic",
};

describe("rate-limit policy resolution", () => {
  it("looks up an exact principal, audience, and scope policy", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ max_requests: 3, window_seconds: 60 }],
    });
    const resolvePolicy = createPostgresRateLimitPolicyResolver({ query } as never);

    await expect(resolvePolicy(context)).resolves.toEqual({
      maxRequests: 3,
      windowSeconds: 60,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      "company:x",
      "agent-b",
      "read:quote:basic",
    ]);
  });

  it("treats a missing policy as unlimited", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const resolvePolicy = createPostgresRateLimitPolicyResolver({ query } as never);
    await expect(resolvePolicy(context)).resolves.toBeNull();
  });
});

describe("createRedisRateLimiter", () => {
  it("does not contact Redis when no policy exists", async () => {
    const redis = { eval: vi.fn() };
    const getPolicy = vi.fn<GetRateLimitPolicy>().mockResolvedValue(null);
    const limiter = createRedisRateLimiter({ redis, getPolicy });

    await expect(limiter(context)).resolves.toEqual({ limited: false, policy: null });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("returns remaining capacity for an allowed request", async () => {
    const redis: RateLimitRedisClient = {
      eval: vi.fn().mockResolvedValue([1, 2, 1_700_000_060, 1_700_000_010]),
    };
    const limiter = createRedisRateLimiter({
      redis,
      getPolicy: vi.fn().mockResolvedValue({ maxRequests: 3, windowSeconds: 60 }),
    });

    await expect(limiter(context)).resolves.toEqual({
      limited: false,
      policy: { maxRequests: 3, windowSeconds: 60 },
      remaining: 1,
      resetAtSeconds: 1_700_000_060,
    });
  });

  it("returns a retry delay without incrementing a denied request", async () => {
    const redis: RateLimitRedisClient = {
      eval: vi.fn().mockResolvedValue([0, 3, 1_700_000_060, 1_700_000_050]),
    };
    const limiter = createRedisRateLimiter({
      redis,
      getPolicy: vi.fn().mockResolvedValue({ maxRequests: 3, windowSeconds: 60 }),
    });

    await expect(limiter(context)).resolves.toEqual({
      limited: true,
      policy: { maxRequests: 3, windowSeconds: 60 },
      remaining: 0,
      resetAtSeconds: 1_700_000_060,
      retryAfterSeconds: 10,
    });
  });

  it("uses collision-safe keys for policy dimensions", () => {
    expect(rateLimitKey(context)).not.toBe(
      rateLimitKey({
        principal: "company",
        audience: "x:agent-b",
        requestedAction: "read:quote:basic",
      }),
    );
  });

  it("rejects malformed Redis responses", async () => {
    const limiter = createRedisRateLimiter({
      redis: { eval: vi.fn().mockResolvedValue([1]) },
      getPolicy: vi.fn().mockResolvedValue({ maxRequests: 3, windowSeconds: 60 }),
    });
    await expect(limiter(context)).rejects.toThrow("invalid rate-limit result");
  });
});
