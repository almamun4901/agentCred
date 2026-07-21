import { describe, expect, it, vi } from "vitest";
import {
  parseBenchmarkOptions,
  percentile,
  rotateScenarioOrder,
  runConcurrentLoad,
  summarizeScenarioTrials,
} from "../src/benchmark.js";

describe("Phase 7 benchmark helpers", () => {
  it("parses defaults and benchmark-only overrides", () => {
    expect(parseBenchmarkOptions([])).toEqual({
      scenarios: ["postgres", "redis", "redis-rate-limit"],
      durationSeconds: 5,
      warmupSeconds: 2,
      fixedConcurrency: 32,
      sweepConcurrencies: [1, 8, 32, 64],
      trials: 3,
    });
    expect(
      parseBenchmarkOptions([
        "--scenario",
        "redis",
        "--duration",
        "0.25",
        "--warmup",
        "0.1",
        "--concurrency",
        "4",
        "--sweep",
        "1,4",
        "--trials",
        "2",
      ]),
    ).toEqual({
      scenarios: ["redis"],
      durationSeconds: 0.25,
      warmupSeconds: 0.1,
      fixedConcurrency: 4,
      sweepConcurrencies: [1, 4],
      trials: 2,
    });
  });

  it.each([
    [["--scenario", "unknown"], "--scenario"],
    [["--duration", "0"], "positive"],
    [["--concurrency", "1.5"], "integer"],
    [["--sweep", "1,1"], "unique"],
    [["--unknown", "1"], "Unknown"],
    [["--duration"], "requires a value"],
  ])("rejects invalid options %j", (args, message) => {
    expect(() => parseBenchmarkOptions(args)).toThrow(message);
  });

  it("calculates nearest-rank percentiles", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(() => percentile([], 50)).toThrow("without samples");
  });

  it("aggregates median latency and peak median throughput", () => {
    expect(
      summarizeScenarioTrials([
        {
          latency: { p50Ms: 1, p95Ms: 2, p99Ms: 3 },
          throughput: [
            { concurrency: 1, requestsPerSecond: 100 },
            { concurrency: 8, requestsPerSecond: 300 },
          ],
        },
        {
          latency: { p50Ms: 2, p95Ms: 3, p99Ms: 4 },
          throughput: [
            { concurrency: 1, requestsPerSecond: 120 },
            { concurrency: 8, requestsPerSecond: 280 },
          ],
        },
        {
          latency: { p50Ms: 3, p95Ms: 4, p99Ms: 5 },
          throughput: [
            { concurrency: 1, requestsPerSecond: 110 },
            { concurrency: 8, requestsPerSecond: 290 },
          ],
        },
      ]),
    ).toEqual({
      p50Ms: 2,
      p95Ms: 3,
      p99Ms: 4,
      maxRequestsPerSecond: 290,
      throughputConcurrency: 8,
    });
  });

  it("rotates scenario order between trials", () => {
    const scenarios = ["postgres", "redis", "redis-rate-limit"] as const;
    expect(rotateScenarioOrder([...scenarios], 0)).toEqual([...scenarios]);
    expect(rotateScenarioOrder([...scenarios], 1)).toEqual([
      "redis",
      "redis-rate-limit",
      "postgres",
    ]);
  });

  it("fails immediately when a request is not allowed", async () => {
    const request = vi.fn().mockResolvedValue(503);
    await expect(
      runConcurrentLoad({
        request,
        durationSeconds: 0.01,
        concurrency: 1,
      }),
    ).rejects.toThrow("HTTP 503");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
