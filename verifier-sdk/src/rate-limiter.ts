import type pg from "pg";

export const RATE_LIMIT_KEY_PREFIX = "agentcred:ratelimit:v1:";

export interface RateLimitPolicy {
  maxRequests: number;
  windowSeconds: number;
}

export interface RateLimitContext {
  principal: string;
  audience: string;
  requestedAction: string;
}

export type RateLimitResult =
  | { limited: false; policy: null }
  | {
      limited: false;
      policy: RateLimitPolicy;
      remaining: number;
      resetAtSeconds: number;
    }
  | {
      limited: true;
      policy: RateLimitPolicy;
      remaining: 0;
      resetAtSeconds: number;
      retryAfterSeconds: number;
    };

export type GetRateLimitPolicy = (
  context: RateLimitContext,
) => Promise<RateLimitPolicy | null>;

export type CheckRateLimit = (
  context: RateLimitContext,
) => Promise<RateLimitResult>;

export interface RateLimitRedisClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

const FIXED_WINDOW_SCRIPT = `
local now = tonumber(redis.call('TIME')[1])
local window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local window_start = now - (now % window)
local reset_at = window_start + window
local stored_start = tonumber(redis.call('HGET', KEYS[1], 'window_start'))
local stored_window = tonumber(redis.call('HGET', KEYS[1], 'window_seconds'))
local count = tonumber(redis.call('HGET', KEYS[1], 'count')) or 0

if stored_start ~= window_start or stored_window ~= window then
  count = 0
  redis.call('HSET', KEYS[1],
    'window_start', window_start,
    'window_seconds', window,
    'count', 0)
end

if count >= maximum then
  redis.call('EXPIREAT', KEYS[1], reset_at + 1)
  return {0, count, reset_at, now}
end

count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('EXPIREAT', KEYS[1], reset_at + 1)
return {1, count, reset_at, now}
`;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function encodeKeyPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function rateLimitKey(context: RateLimitContext): string {
  return `${RATE_LIMIT_KEY_PREFIX}${encodeKeyPart(context.principal)}:${encodeKeyPart(context.audience)}:${encodeKeyPart(context.requestedAction)}`;
}

export function createPostgresRateLimitPolicyResolver(
  queryable: Pick<pg.Pool, "query">,
): GetRateLimitPolicy {
  return async function getRateLimitPolicy(context): Promise<RateLimitPolicy | null> {
    const result = await queryable.query<{
      max_requests: number;
      window_seconds: number;
    }>(
      `SELECT max_requests, window_seconds
       FROM rate_limit_policies
       WHERE principal = $1 AND audience = $2 AND scope = $3`,
      [context.principal, context.audience, context.requestedAction],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    if (
      !isPositiveInteger(row.max_requests) ||
      !isPositiveInteger(row.window_seconds)
    ) {
      throw new Error("Stored rate-limit policy is invalid");
    }
    return {
      maxRequests: row.max_requests,
      windowSeconds: row.window_seconds,
    };
  };
}

function parseInteger(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || value.length === 0)
  ) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createRedisRateLimiter(options: {
  redis: RateLimitRedisClient;
  getPolicy: GetRateLimitPolicy;
}): CheckRateLimit {
  return async function checkRateLimit(context): Promise<RateLimitResult> {
    const policy = await options.getPolicy(context);
    if (policy === null) {
      return { limited: false, policy: null };
    }
    if (
      !isPositiveInteger(policy.maxRequests) ||
      !isPositiveInteger(policy.windowSeconds)
    ) {
      throw new Error("Rate-limit policy must contain positive integers");
    }

    const raw = await options.redis.eval(FIXED_WINDOW_SCRIPT, {
      keys: [rateLimitKey(context)],
      arguments: [String(policy.windowSeconds), String(policy.maxRequests)],
    });
    if (!Array.isArray(raw) || raw.length !== 4) {
      throw new Error("Redis returned an invalid rate-limit result");
    }
    const allowed = parseInteger(raw[0]);
    const count = parseInteger(raw[1]);
    const resetAtSeconds = parseInteger(raw[2]);
    const nowSeconds = parseInteger(raw[3]);
    if (
      (allowed !== 0 && allowed !== 1) ||
      count === null ||
      resetAtSeconds === null ||
      nowSeconds === null ||
      count < 0 ||
      resetAtSeconds <= nowSeconds
    ) {
      throw new Error("Redis returned an invalid rate-limit result");
    }

    if (allowed === 0) {
      return {
        limited: true,
        policy,
        remaining: 0,
        resetAtSeconds,
        retryAfterSeconds: Math.max(1, resetAtSeconds - nowSeconds),
      };
    }
    return {
      limited: false,
      policy,
      remaining: Math.max(0, policy.maxRequests - count),
      resetAtSeconds,
    };
  };
}
