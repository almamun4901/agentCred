import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import { generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { createClient } from "redis";
import {
  createCredentialVerifier,
  createPostgresRateLimitPolicyResolver,
  createPostgresRevocationChecker,
  createRedisRateLimiter,
  createRedisRevocationChecker,
  createVerifierPreHandler,
  rateLimitKey,
  REVOCATION_FRESHNESS_KEY,
  revocationCacheKey,
} from "../dist/index.js";
import {
  parseBenchmarkOptions,
  percentile,
  rotateScenarioOrder,
  runConcurrentLoad,
  summarizeScenarioTrials,
} from "../dist/benchmark.js";

const { Pool } = pg;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "phase7-benchmark-issuer";
const audience = "agent-b";
const requestedAction = "read:quote:basic";

function gitRevision() {
  const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  });
  if (revision.status !== 0) {
    return "unknown";
  }
  const dirty = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  });
  return `${revision.stdout.trim()}${dirty.stdout.trim() === "" ? "" : "-dirty"}`;
}

function redisVersion(info) {
  const match = /^redis_version:([^\r\n]+)$/m.exec(info);
  return match?.[1] ?? "unknown";
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function markdownReport(result) {
  const lines = [
    "## Phase 7 verifier benchmark",
    "",
    "| Scenario | p50 (ms) | p95 (ms) | p99 (ms) | Max sustained req/s | Peak concurrency |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of result.options.scenarios) {
    const summary = result.scenarios[scenario].summary;
    lines.push(
      `| ${scenario} | ${summary.p50Ms.toFixed(3)} | ${summary.p95Ms.toFixed(3)} | ${summary.p99Ms.toFixed(3)} | ${summary.maxRequestsPerSecond.toFixed(0)} | ${summary.throughputConcurrency} |`,
    );
  }
  lines.push(
    "",
    "| Benchmark metadata | Value |",
    "|---|---|",
    `| Captured at | ${result.capturedAt} |`,
    `| Commit | ${result.commit} |`,
    `| Trials | ${result.options.trials} |`,
    `| Warm-up per scenario/trial | ${result.options.warmupSeconds}s |`,
    `| Measured duration per run | ${result.options.durationSeconds}s |`,
    `| Fixed latency concurrency | ${result.options.fixedConcurrency} |`,
    `| Throughput sweep | ${result.options.sweepConcurrencies.join(", ")} |`,
    `| Node | ${result.environment.node} |`,
    `| CPU | ${result.environment.cpu} |`,
    `| PostgreSQL | ${result.environment.postgres} |`,
    `| Redis | ${result.environment.redis} |`,
  );
  return lines.join("\n");
}

function trackedQueryable(pool, operations, field) {
  return {
    async query(...args) {
      operations[field] += 1;
      return pool.query(...args);
    },
  };
}

function createFreshRedisReader(redis, operations) {
  return {
    async mGet(keys) {
      operations.redisRevocation += 1;
      const values = await redis.mGet(keys);
      const freshnessIndex = keys.indexOf(REVOCATION_FRESHNESS_KEY);
      if (freshnessIndex !== -1) {
        values[freshnessIndex] = new Date().toISOString();
      }
      return values;
    },
  };
}

async function buildScenario({
  name,
  pool,
  redis,
  publicKey,
  token,
  principal,
  jti,
}) {
  const operations = {
    postgresRevocation: 0,
    redisRevocation: 0,
    postgresFallback: 0,
    postgresPolicy: 0,
    redisRateLimit: 0,
  };
  const postgresRevocation = createPostgresRevocationChecker(
    trackedQueryable(pool, operations, "postgresRevocation"),
  );
  const fallback = createPostgresRevocationChecker(
    trackedQueryable(pool, operations, "postgresFallback"),
  );
  const redisRevocation = createRedisRevocationChecker({
    redis: createFreshRedisReader(redis, operations),
    fallback,
  });

  let isRevoked = postgresRevocation;
  let checkRateLimit;
  if (name !== "postgres") {
    isRevoked = redisRevocation;
  }
  if (name === "redis-rate-limit") {
    checkRateLimit = createRedisRateLimiter({
      redis: {
        async eval(script, options) {
          operations.redisRateLimit += 1;
          return redis.eval(script, options);
        },
      },
      getPolicy: createPostgresRateLimitPolicyResolver(
        trackedQueryable(pool, operations, "postgresPolicy"),
      ),
    });
  }

  const verifyCredential = createCredentialVerifier({
    publicKey,
    issuer,
    isRevoked,
    checkRateLimit,
  });
  const app = Fastify({ logger: false });
  app.get(
    "/benchmark",
    {
      preHandler: createVerifierPreHandler({
        verifyCredential,
        requestedAction,
        expectedAudience: audience,
      }),
    },
    async () => ({ ok: true }),
  );
  await app.ready();

  const context = { principal, audience, requestedAction };
  const counterKey = rateLimitKey(context);
  return {
    name,
    operations,
    async request() {
      const response = await app.inject({
        method: "GET",
        url: "/benchmark",
        headers: { authorization: `Bearer ${token}` },
      });
      return response.statusCode;
    },
    async beforeRun() {
      if (name === "redis-rate-limit") {
        await redis.del(counterKey);
      }
    },
    async close() {
      await app.close();
      await redis.del(counterKey, revocationCacheKey(jti));
    },
  };
}

function assertOperations(name, operations) {
  if (name === "postgres" && operations.postgresRevocation === 0) {
    throw new Error("PostgreSQL scenario did not query revocations");
  }
  if (name !== "postgres" && operations.redisRevocation === 0) {
    throw new Error(`${name} scenario did not query Redis revocations`);
  }
  if (name !== "postgres" && operations.postgresFallback !== 0) {
    throw new Error(`${name} scenario unexpectedly used PostgreSQL fallback`);
  }
  if (
    name === "redis-rate-limit" &&
    (operations.postgresPolicy === 0 || operations.redisRateLimit === 0)
  ) {
    throw new Error("Rate-limit scenario did not exercise both policy and counter paths");
  }
}

async function measureScenario(scenario, options) {
  await scenario.beforeRun();
  await runConcurrentLoad({
    request: scenario.request,
    durationSeconds: options.warmupSeconds,
    concurrency: options.fixedConcurrency,
    captureLatencies: false,
  });

  await scenario.beforeRun();
  const latencySample = await runConcurrentLoad({
    request: scenario.request,
    durationSeconds: options.durationSeconds,
    concurrency: options.fixedConcurrency,
  });
  const throughput = [];
  for (const concurrency of options.sweepConcurrencies) {
    await scenario.beforeRun();
    const sample = await runConcurrentLoad({
      request: scenario.request,
      durationSeconds: options.durationSeconds,
      concurrency,
      captureLatencies: false,
    });
    throughput.push({
      concurrency,
      requestsPerSecond: sample.requestsPerSecond,
    });
  }
  return {
    latency: {
      p50Ms: percentile(latencySample.latenciesMs, 50),
      p95Ms: percentile(latencySample.latenciesMs, 95),
      p99Ms: percentile(latencySample.latenciesMs, 99),
    },
    throughput,
  };
}

async function main() {
  const options = parseBenchmarkOptions(process.argv.slice(2));
  const pool = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: redisUrl, disableOfflineQueue: true });
  redis.on("error", () => {});
  const jti = `phase7-benchmark-${randomUUID()}`;
  const principal = `phase7-benchmark-${randomUUID()}`;
  const context = { principal, audience, requestedAction };
  const scenarios = new Map();
  let primaryError;

  try {
    const postgresVersionResult = await pool.query("SHOW server_version");
    await redis.connect();
    if ((await redis.ping()) !== "PONG") {
      throw new Error("Redis readiness check failed");
    }
    const redisInfo = await redis.info("server");
    await redis.del(revocationCacheKey(jti), rateLimitKey(context));
    await pool.query(
      `INSERT INTO rate_limit_policies
         (principal, audience, scope, window_seconds, max_requests)
       VALUES ($1, $2, $3, 3600, 1000000)`,
      [principal, audience, requestedAction],
    );

    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      principal,
      scope: [requestedAction],
      delegation_chain: [],
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer(issuer)
      .setSubject("phase7-benchmark-agent")
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 3_600)
      .setJti(jti)
      .sign(privateKey);

    for (const name of options.scenarios) {
      scenarios.set(
        name,
        await buildScenario({
          name,
          pool,
          redis,
          publicKey,
          token,
          principal,
          jti,
        }),
      );
    }

    const trialsByScenario = Object.fromEntries(
      options.scenarios.map((name) => [name, []]),
    );
    for (let trialIndex = 0; trialIndex < options.trials; trialIndex += 1) {
      for (const name of rotateScenarioOrder(options.scenarios, trialIndex)) {
        console.error(
          `Phase 7 benchmark: trial ${trialIndex + 1}/${options.trials}, ${name}`,
        );
        const scenario = scenarios.get(name);
        trialsByScenario[name].push(await measureScenario(scenario, options));
      }
    }

    const scenarioResults = {};
    for (const name of options.scenarios) {
      const scenario = scenarios.get(name);
      assertOperations(name, scenario.operations);
      const trials = trialsByScenario[name];
      scenarioResults[name] = {
        summary: Object.fromEntries(
          Object.entries(summarizeScenarioTrials(trials)).map(([key, value]) => [
            key,
            typeof value === "number" ? round(value) : value,
          ]),
        ),
        operations: scenario.operations,
        trials,
      };
    }

    const result = {
      capturedAt: new Date().toISOString(),
      commit: gitRevision(),
      options,
      environment: {
        node: process.version,
        cpu: cpus()[0]?.model ?? "unknown",
        postgres: postgresVersionResult.rows[0]?.server_version ?? "unknown",
        redis: redisVersion(redisInfo),
      },
      scenarios: scenarioResults,
    };
    console.log("PHASE7_JSON_START");
    console.log(JSON.stringify(result, null, 2));
    console.log("PHASE7_JSON_END");
    console.log("");
    console.log(markdownReport(result));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const scenario of scenarios.values()) {
      try {
        await scenario.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (redis.isOpen) {
        await redis.del(revocationCacheKey(jti), rateLimitKey(context));
        await redis.quit();
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await pool.query(
        `DELETE FROM rate_limit_policies
         WHERE principal = $1 AND audience = $2 AND scope = $3`,
        [principal, audience, requestedAction],
      );
      await pool.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (primaryError === undefined && cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Phase 7 benchmark cleanup failed");
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Phase 7 benchmark failed");
  process.exitCode = 1;
});
