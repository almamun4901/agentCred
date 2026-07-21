import type { IsRevoked } from "./verify.js";

export const REVOCATION_CACHE_PREFIX = "agentcred:revocation:";
export const REVOCATION_FRESHNESS_KEY = "agentcred:revocations:fresh";

export interface RevocationCacheReader {
  mGet(keys: string[]): Promise<Array<string | null>>;
}

export interface RevocationCacheWriter {
  set(
    key: string,
    value: string,
    options: { expiration: { type: "EX" | "EXAT"; value: number } },
  ): Promise<unknown>;
}

export interface CachedRevocation {
  jti: string;
  expiresAt: Date;
}

export function revocationCacheKey(jti: string): string {
  return `${REVOCATION_CACHE_PREFIX}${jti}`;
}

export function revocationExpirySeconds(
  expiresAt: Date,
  now: Date = new Date(),
): number | null {
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  return expiresAtSeconds > nowSeconds ? expiresAtSeconds : null;
}

export async function cacheRevocation(
  redis: RevocationCacheWriter,
  revocation: CachedRevocation,
  now: Date = new Date(),
): Promise<boolean> {
  const expiresAtSeconds = revocationExpirySeconds(revocation.expiresAt, now);
  if (expiresAtSeconds === null) {
    return false;
  }

  await redis.set(revocationCacheKey(revocation.jti), "1", {
    expiration: { type: "EXAT", value: expiresAtSeconds },
  });
  return true;
}

export interface RedisRevocationCheckerOptions {
  redis: RevocationCacheReader;
  fallback: IsRevoked;
}

export function createRedisRevocationChecker(
  options: RedisRevocationCheckerOptions,
): IsRevoked {
  return async function isRevoked(jti: string): Promise<boolean> {
    try {
      const values = await options.redis.mGet([
        REVOCATION_FRESHNESS_KEY,
        revocationCacheKey(jti),
      ]);
      if (values.length !== 2) {
        return options.fallback(jti);
      }

      const [freshness, revoked] = values;
      if (
        freshness === null ||
        !Number.isFinite(Date.parse(freshness)) ||
        (revoked !== null && revoked !== "1")
      ) {
        return options.fallback(jti);
      }

      return revoked === "1";
    } catch {
      return options.fallback(jti);
    }
  };
}
