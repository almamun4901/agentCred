import { describe, expect, it, vi } from "vitest";
import { REVOCATION_FRESHNESS_KEY, revocationCacheKey } from "@agent-cred/verifier-sdk";
import {
  createRevocationSynchronizer,
  readSyncIntervalSeconds,
} from "../src/jobs/sync-revocations.js";

function createRedis(options: { fail?: boolean } = {}) {
  const commands: unknown[][] = [];
  const exec = vi.fn(async () => {
    if (options.fail) {
      throw new Error("sensitive redis failure");
    }
    return commands.map(() => "OK");
  });
  return {
    commands,
    exec,
    set: vi.fn(async (key: string, value: string, settings: unknown) => {
      if (options.fail) {
        throw new Error("sensitive redis failure");
      }
      commands.push([key, value, settings]);
      return "OK";
    }),
    multi: vi.fn(() => ({
      set(key: string, value: string, settings: unknown) {
        commands.push([key, value, settings]);
        return this;
      },
      exec,
    })),
  };
}

describe("revocation synchronizer", () => {
  const startedAt = new Date("2026-07-21T15:00:00.000Z");

  it("publishes active revocations and refreshes freshness after the batch", async () => {
    const redis = createRedis();
    const logger = { info: vi.fn(), error: vi.fn() };
    const synchronizer = createRevocationSynchronizer({
      repository: {
        listActiveRevocations: vi.fn(async () => [
          { jti: "active-jti", expires_at: new Date("2026-07-21T15:05:00Z") },
        ]),
      },
      redis,
      intervalSeconds: 5,
      logger,
      now: () => startedAt,
    });

    await expect(synchronizer.syncOnce()).resolves.toBe(1);
    expect(redis.commands).toEqual([
      [
        revocationCacheKey("active-jti"),
        "1",
        { expiration: { type: "EXAT", value: 1_784_646_300 } },
      ],
      [REVOCATION_FRESHNESS_KEY, startedAt.toISOString(), { expiration: { type: "EX", value: 15 } }],
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      { rows_synced: 1, duration_ms: 0 },
      "Revocation cache sync completed",
    );
  });

  it("refreshes freshness after an empty successful run", async () => {
    const redis = createRedis();
    const synchronizer = createRevocationSynchronizer({
      repository: { listActiveRevocations: vi.fn(async () => []) },
      redis,
      intervalSeconds: 5,
      logger: { info: vi.fn(), error: vi.fn() },
      now: () => startedAt,
    });

    await expect(synchronizer.syncOnce()).resolves.toBe(0);
    expect(redis.commands).toHaveLength(1);
    expect(redis.commands[0]?.[0]).toBe(REVOCATION_FRESHNESS_KEY);
  });

  it("logs a sanitized failure and does not report success", async () => {
    const redis = createRedis({ fail: true });
    const logger = { info: vi.fn(), error: vi.fn() };
    const synchronizer = createRevocationSynchronizer({
      repository: {
        listActiveRevocations: vi.fn(async () => [
          { jti: "failed-jti", expires_at: new Date("2026-07-21T15:05:00Z") },
        ]),
      },
      redis,
      intervalSeconds: 5,
      logger,
      now: () => startedAt,
    });

    await expect(synchronizer.syncOnce()).rejects.toThrow("sensitive redis failure");
    expect(logger.info).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { error_name: "Error" },
      "Revocation cache sync failed",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("sensitive");
  });

  it("schedules the next run only after the current run finishes and stops cleanly", async () => {
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const handle = { unref: vi.fn() };
    const timers = {
      setTimeout: vi.fn((callback: () => void) => {
        callbacks.push(callback);
        return handle;
      }),
      clearTimeout: vi.fn((value: unknown) => cleared.push(value)),
    };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = {
      listActiveRevocations: vi.fn(async () => {
        await pending;
        return [];
      }),
    };
    const synchronizer = createRevocationSynchronizer({
      repository,
      redis: createRedis(),
      intervalSeconds: 5,
      logger: { info: vi.fn(), error: vi.fn() },
      now: () => startedAt,
      timers,
    });

    synchronizer.start();
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    expect(repository.listActiveRevocations).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    synchronizer.stop();
    expect(cleared).toEqual([handle]);
  });

  it.each(["0", "1.5", "nope"])("rejects invalid interval %s", (value) => {
    expect(() => readSyncIntervalSeconds(value)).toThrow(
      "REVOCATION_SYNC_INTERVAL_SECONDS must be a positive integer",
    );
  });
});
