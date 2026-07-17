import type { FastifyInstance } from "fastify";
import type { IssuanceRepository } from "../db.js";
import type { CredentialSigner } from "../sign.js";

interface IssueBody {
  agent_id: string;
  principal: string;
  scope: string[];
  aud: string;
  ttl: number;
}

interface IssuanceParams {
  jti: string;
}

export interface IssueRoutesOptions {
  repository: IssuanceRepository;
  signCredential: CredentialSigner;
}

const nonBlankString = { type: "string", minLength: 1, pattern: ".*\\S.*" } as const;

export async function registerIssueRoutes(
  app: FastifyInstance,
  options: IssueRoutesOptions,
): Promise<void> {
  app.post<{ Body: IssueBody }>(
    "/issue",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["agent_id", "principal", "scope", "aud", "ttl"],
          properties: {
            agent_id: nonBlankString,
            principal: nonBlankString,
            scope: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: nonBlankString,
            },
            aud: nonBlankString,
            ttl: { type: "integer", minimum: 1, maximum: 3600 },
          },
        },
      },
    },
    async (request, reply) => {
      const signed = await options.signCredential({
        agentId: request.body.agent_id,
        principal: request.body.principal,
        scope: request.body.scope,
        audience: request.body.aud,
        ttlSeconds: request.body.ttl,
      });

      await options.repository.createIssuance(signed.claims);
      return reply.code(200).send({ token: signed.token });
    },
  );

  app.get<{ Params: IssuanceParams }>(
    "/issuances/:jti",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["jti"],
          properties: { jti: nonBlankString },
        },
      },
    },
    async (request, reply) => {
      const issuance = await options.repository.getIssuance(request.params.jti);
      if (!issuance) {
        return reply.code(404).send({ error: "issuance_not_found" });
      }

      return reply.code(200).send({
        ...issuance,
        issued_at: issuance.issued_at.toISOString(),
        expires_at: issuance.expires_at.toISOString(),
      });
    },
  );
}
