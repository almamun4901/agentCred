import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createIssuanceRepository,
  createPool,
  type IssuanceRepository,
} from "./db.js";
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
}

export function buildServer(
  dependencies: ServerDependencies,
  options: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });

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

async function start(): Promise<void> {
  const privateKeyPath = resolve(
    process.env.SIGNING_PRIVATE_KEY_PATH ?? "keys/private.pem",
  );
  const privateKeyPem = await readFile(privateKeyPath, "utf8");
  const privateKey = await importSigningKey(privateKeyPem);
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const app = buildServer(
    {
      repository: createIssuanceRepository(pool),
      signCredential: createCredentialSigner({
        issuer: process.env.ISSUER_ID ?? "agentcred-issuer",
        privateKey,
      }),
    },
    { logger: true },
  );

  app.addHook("onClose", async () => {
    await pool.end();
  });

  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  await app.listen({ host: "127.0.0.1", port });
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
