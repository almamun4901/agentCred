import {
  REVOCATION_FRESHNESS_KEY,
  revocationCacheKey,
  revocationExpirySeconds,
} from "@agent-cred/verifier-sdk";
import type { RevocationSyncRepository } from "../db.js";

interface RedisBatch {
  set(
    key: string,
    value: string,
    options: { expiration: { type: "EX" | "EXAT"; value: number } },
  ): RedisBatch;
  exec(): Promise<unknown>;
}

export interface RevocationSyncRedis {
  multi(): RedisBatch;
  set(
    key: string,
    value: string,
    options: { expiration: { type: "EX"; value: number } },
  ): Promise<unknown>;
}

export interface RevocationSyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

interface TimerHandle {
  unref?(): void;
}

export interface RevocationSyncTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface RevocationSynchronizerOptions {
  repository: RevocationSyncRepository;
  redis: RevocationSyncRedis;
  intervalSeconds: number;
  logger: RevocationSyncLogger;
  now?: () => Date;
  timers?: RevocationSyncTimers;
}

export interface RevocationSynchronizer {
  syncOnce(): Promise<number>;
  start(): void;
  stop(): void;
}

const defaultTimers: RevocationSyncTimers = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createRevocationSynchronizer(
  options: RevocationSynchronizerOptions,
): RevocationSynchronizer {
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 1) {
    throw new Error("intervalSeconds must be a positive integer");
  }

  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? defaultTimers;
  const intervalMs = options.intervalSeconds * 1_000;
  const freshnessTtlSeconds = options.intervalSeconds * 3;
  let timer: TimerHandle | undefined;
  let stopped = true;

  const syncOnce = async (): Promise<number> => {
    const startedAt = now();
    try {
      const rows = await options.repository.listActiveRevocations(startedAt);
      const batch = options.redis.multi();
      let rowsSynced = 0;

      for (const row of rows) {
        const expiresAtSeconds = revocationExpirySeconds(row.expires_at, startedAt);
        if (expiresAtSeconds === null) {
          continue;
        }
        batch.set(revocationCacheKey(row.jti), "1", {
          expiration: { type: "EXAT", value: expiresAtSeconds },
        });
        rowsSynced += 1;
      }

      if (rowsSynced > 0) {
        const result = await batch.exec();
        if (
          result === null ||
          (Array.isArray(result) && result.some((entry) => entry instanceof Error))
        ) {
          throw new Error("Redis revocation batch failed");
        }
      }
      await options.redis.set(REVOCATION_FRESHNESS_KEY, startedAt.toISOString(), {
        expiration: { type: "EX", value: freshnessTtlSeconds },
      });

      options.logger.info(
        {
          rows_synced: rowsSynced,
          duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
        },
        "Revocation cache sync completed",
      );
      return rowsSynced;
    } catch (error: unknown) {
      options.logger.error(
        { error_name: error instanceof Error ? error.name : "UnknownError" },
        "Revocation cache sync failed",
      );
      throw error;
    }
  };

  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = timers.setTimeout(() => {
      timer = undefined;
      void syncOnce()
        .catch(() => undefined)
        .finally(schedule);
    }, intervalMs);
    timer.unref?.();
  };

  return {
    syncOnce,
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        timers.clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

export function readSyncIntervalSeconds(value: string | undefined): number {
  const interval = Number(value ?? 5);
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error("REVOCATION_SYNC_INTERVAL_SECONDS must be a positive integer");
  }
  return interval;
}
