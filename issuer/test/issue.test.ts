import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Issuance, IssuanceRepository } from "../src/db.js";
import { buildServer } from "../src/server.js";
import { createCredentialSigner } from "../src/sign.js";

function createMemoryRepository(): IssuanceRepository {
  const rows = new Map<string, Issuance>();
  return {
    async createIssuance(claims) {
      rows.set(claims.jti, {
        jti: claims.jti,
        agent_id: claims.sub,
        principal: claims.principal,
        scope: claims.scope,
        audience: claims.aud,
        issued_at: new Date(claims.iat * 1_000),
        expires_at: new Date(claims.exp * 1_000),
        delegation_chain: claims.delegation_chain,
      });
    },
    async getIssuance(jti) {
      return rows.get(jti) ?? null;
    },
    async revokeIssuance() {
      return null;
    },
  };
}

describe("issuer routes", () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    const { privateKey } = await generateKeyPair("ES256");
    app = buildServer({
      repository: createMemoryRepository(),
      publishRevocation: async () => undefined,
      signCredential: createCredentialSigner({
        issuer: "test-issuer",
        privateKey,
        now: () => 1_700_000_000_000,
        generateJti: () => "route-test-jti",
      }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const validBody = {
    agent_id: "agent-a",
    principal: "company-x",
    scope: ["read:weather"],
    aud: "agent-b",
    ttl: 300,
  };

  it("reports process liveness without exposing dependency details", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("issues a token and exposes its stored metadata", async () => {
    const issued = await app.inject({ method: "POST", url: "/issue", payload: validBody });
    expect(issued.statusCode).toBe(200);
    expect(issued.json()).toEqual({ token: expect.any(String) });

    const fetched = await app.inject({ method: "GET", url: "/issuances/route-test-jti" });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      jti: "route-test-jti",
      agent_id: "agent-a",
      principal: "company-x",
      scope: ["read:weather"],
      audience: "agent-b",
      issued_at: "2023-11-14T22:13:20.000Z",
      expires_at: "2023-11-14T22:18:20.000Z",
      delegation_chain: [],
    });
  });

  it.each([
    ["missing scope", { ...validBody, scope: undefined }],
    ["empty scope", { ...validBody, scope: [] }],
    ["duplicate scopes", { ...validBody, scope: ["read:weather", "read:weather"] }],
    ["blank agent", { ...validBody, agent_id: "   " }],
    ["blank principal", { ...validBody, principal: "   " }],
    ["blank audience", { ...validBody, aud: "   " }],
    ["blank scope", { ...validBody, scope: ["   "] }],
    ["zero TTL", { ...validBody, ttl: 0 }],
    ["excessive TTL", { ...validBody, ttl: 3601 }],
    ["fractional TTL", { ...validBody, ttl: 1.5 }],
    ["unknown field", { ...validBody, unexpected: true }],
  ])("returns 400 for %s", async (_name, payload) => {
    const response = await app.inject({ method: "POST", url: "/issue", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_error" });
  });

  it("returns 404 for an unknown JTI", async () => {
    const response = await app.inject({ method: "GET", url: "/issuances/unknown" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "issuance_not_found" });
  });

  it("does not release a token when persistence fails", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    await app.close();
    app = buildServer({
      repository: {
        async createIssuance() {
          throw new Error("database detail that must stay private");
        },
        async getIssuance() {
          return null;
        },
        async revokeIssuance() {
          return null;
        },
      },
      publishRevocation: async () => undefined,
      signCredential: createCredentialSigner({
        issuer: "test-issuer",
        privateKey,
      }),
    });

    const response = await app.inject({ method: "POST", url: "/issue", payload: validBody });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_server_error" });
    expect(response.body).not.toContain("token");
    expect(response.body).not.toContain("database detail");
  });
});
