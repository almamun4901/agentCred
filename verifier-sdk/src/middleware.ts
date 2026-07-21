import type { preHandlerHookHandler } from "fastify";
import type { VerifiedCredentialClaims, VerifyCredential } from "./verify.js";

declare module "fastify" {
  interface FastifyRequest {
    credential?: VerifiedCredentialClaims;
  }
}

export interface VerifierPreHandlerOptions {
  verifyCredential: VerifyCredential;
  requestedAction: string;
  expectedAudience: string;
}

function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function createVerifierPreHandler(
  options: VerifierPreHandlerOptions,
): preHandlerHookHandler {
  return async function verifierPreHandler(request, reply): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null) {
      reply.header("www-authenticate", "Bearer");
      await reply.code(401).send({
        error: "credential_denied",
        reason: "missing_credential",
      });
      return;
    }

    const result = await options.verifyCredential(
      token,
      options.requestedAction,
      options.expectedAudience,
    );

    if (result.decision === "allow") {
      request.credential = result.claims;
      return;
    }

    if (result.reason === "verification_unavailable") {
      await reply.code(503).send({
        error: "credential_denied",
        reason: result.reason,
      });
      return;
    }

    if (result.reason === "scope_exceeded") {
      await reply.code(403).send({
        error: "credential_denied",
        reason: result.reason,
      });
      return;
    }

    if (result.reason === "rate_limited") {
      reply.header("retry-after", String(result.retryAfterSeconds));
      await reply.code(429).send({
        error: "credential_denied",
        reason: result.reason,
      });
      return;
    }

    reply.header("www-authenticate", "Bearer");
    await reply.code(401).send({
      error: "credential_denied",
      reason: result.reason,
    });
  };
}
