import type { FastifyInstance } from "fastify";
import type { IssuanceRepository } from "../db.js";
import type { Revocation } from "../db.js";

interface RevokeBody {
  jti: string;
  reason?: string;
}

export interface RevokeRoutesOptions {
  repository: IssuanceRepository;
  publishRevocation: (revocation: Revocation) => Promise<void>;
}

const nonBlankString = { type: "string", minLength: 1, pattern: ".*\\S.*" } as const;

export async function registerRevokeRoutes(
  app: FastifyInstance,
  options: RevokeRoutesOptions,
): Promise<void> {
  app.post<{ Body: RevokeBody }>(
    "/revoke",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["jti"],
          properties: {
            jti: nonBlankString,
            reason: nonBlankString,
          },
        },
      },
    },
    async (request, reply) => {
      const revocation = await options.repository.revokeIssuance(
        request.body.jti,
        request.body.reason ?? null,
      );
      if (!revocation) {
        return reply.code(404).send({ error: "issuance_not_found" });
      }

      try {
        await options.publishRevocation(revocation);
      } catch {
        request.log.error("Revocation cache write-through failed");
        return reply.code(503).send({
          error: "revocation_propagation_unavailable",
        });
      }

      return reply.code(200).send({
        jti: revocation.jti,
        revoked_at: revocation.revoked_at.toISOString(),
        reason: revocation.reason,
      });
    },
  );
}
