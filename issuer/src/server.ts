import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { createClient } from "redis";
import { cacheRevocation } from "@agent-cred/verifier-sdk";
import {
  createIssuanceRepository,
  createPool,
  createRevocationSyncRepository,
  type IssuanceRepository,
  type Revocation,
} from "./db.js";
import {
  createRevocationSynchronizer,
  readSyncIntervalSeconds,
} from "./jobs/sync-revocations.js";
import { registerIssueRoutes } from "./routes/issue.js";
import { registerRevokeRoutes } from "./routes/revoke.js";
import {
  createCredentialSigner,
  importSigningKey,
  type CredentialSigner,
} from "./sign.js";

export interface ServerDependencies {
  repository: IssuanceRepository;
  signCredential: CredentialSigner;
  publishRevocation: (revocation: Revocation) => Promise<void>;
}

export function buildServer(
  dependencies: ServerDependencies,
  options: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.setErrorHandler((error, request, reply) => {
    const isValidationError =
      typeof error === "object" && error !== null && "validation" in error;
    if (isValidationError) {
      void reply.code(400).send({
        error: "validation_error",
        message: error instanceof Error ? error.message : "Invalid request",
      });
      return;
    }

    request.log.error({ err: error }, "Request failed");
    void reply.code(500).send({ error: "internal_server_error" });
  });

  void app.register(registerIssueRoutes, dependencies);
  void app.register(registerRevokeRoutes, dependencies);
  return app;
}

const DEFAULT_DATABASE_URL =
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

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
  const privateKeyPath = resolve(
    process.env.SIGNING_PRIVATE_KEY_PATH ?? "keys/private.pem",
  );
  const privateKeyPem = await readFile(privateKeyPath, "utf8");
  const privateKey = await importSigningKey(privateKeyPem);
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
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
  let synchronizer: ReturnType<typeof createRevocationSynchronizer> | undefined;

  try {
    await redis.connect();
    const repository = createIssuanceRepository(pool);
    app = buildServer(
      {
        repository,
        signCredential: createCredentialSigner({
          issuer: process.env.ISSUER_ID ?? "agentcred-issuer",
          privateKey,
        }),
        publishRevocation: async (revocation) => {
          await cacheRevocation(redis, {
            jti: revocation.jti,
            expiresAt: revocation.expires_at,
          });
        },
      },
      { logger: true },
    );
    synchronizer = createRevocationSynchronizer({
      repository: createRevocationSyncRepository(pool),
      redis,
      intervalSeconds: readSyncIntervalSeconds(
        process.env.REVOCATION_SYNC_INTERVAL_SECONDS,
      ),
      logger: app.log,
    });
    app.addHook("onClose", async () => {
      synchronizer?.stop();
      if (redis.isOpen) {
        await redis.quit();
      }
      await pool.end();
    });
    installGracefulShutdown(app);

    await synchronizer.syncOnce();
    synchronizer.start();

    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("PORT must be an integer between 1 and 65535");
    }

    await app.listen({ host: readHost(process.env.HOST), port });
  } catch (error: unknown) {
    synchronizer?.stop();
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
    console.error(error instanceof Error ? error.message : "Issuer startup failed");
    process.exitCode = 1;
  });
}
