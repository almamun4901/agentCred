import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { importSPKI } from "jose";
import pg from "pg";
import { createClient } from "redis";
import {
  createCredentialVerifier,
  createPostgresRateLimitPolicyResolver,
  createPostgresRevocationChecker,
  createRedisRateLimiter,
  createRedisRevocationChecker,
  createVerifierPreHandler,
  type VerificationEvent,
  type VerifyCredential,
} from "@agent-cred/verifier-sdk";
import { createPostgresAuditObserver } from "./audit.js";

const { Pool } = pg;

const DEFAULT_DATABASE_URL =
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const DEFAULT_QUOTE = "Trust is scoped, verified, and revocable.";

export interface AgentBDependencies {
  verifyCredential: VerifyCredential;
  audience?: string;
}

export function buildServer(
  dependencies: AgentBDependencies,
  options: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const audience = dependencies.audience ?? "agent-b";

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get(
    "/get-quote",
    {
      preHandler: createVerifierPreHandler({
        verifyCredential: dependencies.verifyCredential,
        requestedAction: "read:quote:basic",
        expectedAudience: audience,
      }),
    },
    async (request) => ({
      quote: DEFAULT_QUOTE,
      served_to: request.credential?.principal,
    }),
  );

  return app;
}

export async function assertDatabaseReady(
  queryable: Pick<pg.Pool, "query">,
): Promise<void> {
  await queryable.query("SELECT 1");
}

export async function assertRedisReady(
  redis: { ping(): Promise<string> },
): Promise<void> {
  const response = await redis.ping();
  if (response !== "PONG") {
    throw new Error("Redis readiness check failed");
  }
}

function readPort(value: string | undefined): number {
  const port = Number(value ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (/\s/.test(host)) {
    throw new Error("HOST must not contain whitespace");
  }
  return host;
}

function installGracefulShutdown(app: FastifyInstance): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "Graceful shutdown started");
    void app.close().catch((error: unknown) => {
      app.log.error({ err: error }, "Graceful shutdown failed");
      process.exitCode = 1;
    });
  };
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");

  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  app.addHook("onClose", async () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  });
}

async function start(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const publicKeyPath = resolve(
    process.env.VERIFYING_PUBLIC_KEY_PATH ?? "../../issuer/keys/public.pem",
  );
  const issuer = process.env.ISSUER_ID ?? "agentcred-issuer";
  const audience = process.env.AGENT_B_AUDIENCE ?? "agent-b";
  const pool = new Pool({ connectionString: databaseUrl });
  let app: FastifyInstance | undefined;
  const redis = createClient({
    url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
    disableOfflineQueue: true,
  });
  redis.on("error", () => {
    if (app === undefined) {
      console.error("Redis client error");
    } else {
      app.log.error("Redis client error");
    }
  });

  try {
    await assertDatabaseReady(pool);
    await redis.connect();
    await assertRedisReady(redis);
    const publicKey = await importSPKI(await readFile(publicKeyPath, "utf8"), "ES256");
    const onDecision = createPostgresAuditObserver(pool);
    const verifyCredential = createCredentialVerifier({
      publicKey,
      issuer,
      isRevoked: createRedisRevocationChecker({
        redis,
        fallback: createPostgresRevocationChecker(pool),
      }),
      checkRateLimit: createRedisRateLimiter({
        redis,
        getPolicy: createPostgresRateLimitPolicyResolver(pool),
      }),
      onDecision,
      onDecisionError(error: unknown, event: VerificationEvent) {
        app?.log.error(
          { err: error, verificationEvent: event },
          "Verification audit write failed after retry",
        );
      },
    });
    app = buildServer({ verifyCredential, audience }, { logger: true });
    app.addHook("onClose", async () => {
      if (redis.isOpen) {
        await redis.quit();
      }
      await pool.end();
    });
    installGracefulShutdown(app);
    await app.listen({
      host: readHost(process.env.HOST),
      port: readPort(process.env.PORT),
    });
  } catch (error: unknown) {
    if (app !== undefined) {
      await app.close();
    } else {
      if (redis.isOpen) {
        await redis.quit();
      }
      await pool.end();
    }
    throw error;
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  start().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Agent B startup failed");
    process.exitCode = 1;
  });
}
