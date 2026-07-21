import type { FastifyInstance } from "fastify";
import type { IssuanceRepository } from "../db.js";

interface RevokeBody {
  jti: string;
  reason?: string;
}

export interface RevokeRoutesOptions {
  repository: IssuanceRepository;
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

      return reply.code(200).send({
        ...revocation,
        revoked_at: revocation.revoked_at.toISOString(),
      });
    },
  );
}
