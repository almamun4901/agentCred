import { performance } from "node:perf_hooks";

export const benchmarkScenarios = [
  "postgres",
  "redis",
  "redis-rate-limit",
] as const;

export type BenchmarkScenario = (typeof benchmarkScenarios)[number];

export interface BenchmarkOptions {
  scenarios: BenchmarkScenario[];
  durationSeconds: number;
  warmupSeconds: number;
  fixedConcurrency: number;
  sweepConcurrencies: number[];
  trials: number;
}

export interface LoadSample {
  requestCount: number;
  durationSeconds: number;
  requestsPerSecond: number;
  latenciesMs: number[];
}

export interface ScenarioTrial {
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  throughput: Array<{
    concurrency: number;
    requestsPerSecond: number;
  }>;
}

export interface ScenarioSummary {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxRequestsPerSecond: number;
  throughputConcurrency: number;
}

const DEFAULT_OPTIONS: BenchmarkOptions = {
  scenarios: [...benchmarkScenarios],
  durationSeconds: 5,
  warmupSeconds: 2,
  fixedConcurrency: 32,
  sweepConcurrencies: [1, 8, 32, 64],
  trials: 3,
};

function readPositiveNumber(name: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function readPositiveInteger(name: string, value: string | undefined): number {
  const parsed = readPositiveNumber(name, value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readScenario(value: string | undefined): BenchmarkScenario[] {
  if (value === undefined || value === "all") {
    return [...benchmarkScenarios];
  }
  if ((benchmarkScenarios as readonly string[]).includes(value)) {
    return [value as BenchmarkScenario];
  }
  throw new Error(
    `--scenario must be one of all, ${benchmarkScenarios.join(", ")}`,
  );
}

function optionValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${args[index]} requires a value`);
  }
  return value;
}

export function parseBenchmarkOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    ...DEFAULT_OPTIONS,
    scenarios: [...DEFAULT_OPTIONS.scenarios],
    sweepConcurrencies: [...DEFAULT_OPTIONS.sweepConcurrencies],
  };

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = optionValue(args, index);
    switch (flag) {
      case "--scenario":
        options.scenarios = readScenario(value);
        break;
      case "--duration":
        options.durationSeconds = readPositiveNumber("--duration", value);
        break;
      case "--warmup":
        options.warmupSeconds = readPositiveNumber("--warmup", value);
        break;
      case "--concurrency":
        options.fixedConcurrency = readPositiveInteger("--concurrency", value);
        break;
      case "--sweep": {
        const levels = value.split(",").map((item) =>
          readPositiveInteger("--sweep", item),
        );
        if (new Set(levels).size !== levels.length) {
          throw new Error("--sweep concurrency levels must be unique");
        }
        options.sweepConcurrencies = levels;
        break;
      }
      case "--trials":
        options.trials = readPositiveInteger("--trials", value);
        break;
      default:
        throw new Error(`Unknown benchmark option: ${flag}`);
    }
  }

  return options;
}

export function percentile(values: number[], percentage: number): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a percentile without samples");
  }
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("Percentile must be between 0 and 100");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index]!;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a median without samples");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export async function runConcurrentLoad(options: {
  request: () => Promise<number>;
  durationSeconds: number;
  concurrency: number;
  captureLatencies?: boolean;
}): Promise<LoadSample> {
  if (options.durationSeconds <= 0 || options.concurrency <= 0) {
    throw new Error("Load duration and concurrency must be positive");
  }

  const durationMs = options.durationSeconds * 1_000;
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  const latenciesMs: number[] = [];
  let requestCount = 0;
  let firstFailure: Error | undefined;

  const worker = async (): Promise<void> => {
    while (performance.now() < deadline && firstFailure === undefined) {
      const requestStartedAt = performance.now();
      try {
        const statusCode = await options.request();
        if (statusCode !== 200) {
          throw new Error(`Benchmark request returned HTTP ${statusCode}`);
        }
      } catch (error: unknown) {
        firstFailure =
          error instanceof Error ? error : new Error("Benchmark request failed");
        return;
      }
      requestCount += 1;
      if (options.captureLatencies ?? true) {
        latenciesMs.push(performance.now() - requestStartedAt);
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  if (requestCount === 0) {
    throw new Error("Benchmark completed without requests");
  }
  return {
    requestCount,
    durationSeconds: elapsedSeconds,
    requestsPerSecond: requestCount / elapsedSeconds,
    latenciesMs,
  };
}

export function summarizeScenarioTrials(
  trials: ScenarioTrial[],
): ScenarioSummary {
  if (trials.length === 0) {
    throw new Error("Cannot summarize a scenario without trials");
  }
  const concurrencyLevels = trials[0]!.throughput.map(
    (item) => item.concurrency,
  );
  if (
    concurrencyLevels.length === 0 ||
    trials.some(
      (trial) =>
        trial.throughput.length !== concurrencyLevels.length ||
        trial.throughput.some(
          (item, index) => item.concurrency !== concurrencyLevels[index],
        ),
    )
  ) {
    throw new Error("Scenario trials must use identical throughput sweeps");
  }

  const throughputByConcurrency = concurrencyLevels.map((concurrency, index) => ({
    concurrency,
    requestsPerSecond: median(
      trials.map((trial) => trial.throughput[index]!.requestsPerSecond),
    ),
  }));
  const peak = throughputByConcurrency.reduce((best, current) =>
    current.requestsPerSecond > best.requestsPerSecond ? current : best,
  );

  return {
    p50Ms: median(trials.map((trial) => trial.latency.p50Ms)),
    p95Ms: median(trials.map((trial) => trial.latency.p95Ms)),
    p99Ms: median(trials.map((trial) => trial.latency.p99Ms)),
    maxRequestsPerSecond: peak.requestsPerSecond,
    throughputConcurrency: peak.concurrency,
  };
}

export function rotateScenarioOrder(
  scenarios: BenchmarkScenario[],
  trialIndex: number,
): BenchmarkScenario[] {
  if (scenarios.length === 0) {
    return [];
  }
  const offset = trialIndex % scenarios.length;
  return [...scenarios.slice(offset), ...scenarios.slice(0, offset)];
}
