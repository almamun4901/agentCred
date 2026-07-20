import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { importSPKI } from "jose";
import pg from "pg";
import {
  createCredentialVerifier,
  createPostgresRevocationChecker,
  createVerifierPreHandler,
  type VerificationEvent,
  type VerifyCredential,
} from "@agent-cred/verifier-sdk";
import { createPostgresAuditObserver } from "./audit.js";

const { Pool } = pg;

const DEFAULT_DATABASE_URL =
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";
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

function readPort(value: string | undefined): number {
  const port = Number(value ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
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

  try {
    await assertDatabaseReady(pool);
    const publicKey = await importSPKI(await readFile(publicKeyPath, "utf8"), "ES256");
    const onDecision = createPostgresAuditObserver(pool);
    const verifyCredential = createCredentialVerifier({
      publicKey,
      issuer,
      isRevoked: createPostgresRevocationChecker(pool),
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
      await pool.end();
    });
    await app.listen({ host: "127.0.0.1", port: readPort(process.env.PORT) });
  } catch (error: unknown) {
    if (app !== undefined) {
      await app.close();
    } else {
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
