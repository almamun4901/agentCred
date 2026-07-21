import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Issuance,
  IssuanceRepository,
  Revocation,
} from "../src/db.js";
import { buildServer } from "../src/server.js";
import { createCredentialSigner } from "../src/sign.js";

function createMemoryRepository(): IssuanceRepository {
  const issuedAt = new Date("2026-07-20T12:00:00.000Z");
  const issuances = new Map<string, Issuance>([
    [
      "known-jti",
      {
        jti: "known-jti",
        agent_id: "agent-a",
        principal: "company-x",
        scope: ["read:quote:basic"],
        audience: "agent-b",
        issued_at: issuedAt,
        expires_at: new Date("2026-07-20T12:05:00.000Z"),
        delegation_chain: [],
      },
    ],
  ]);
  const revocations = new Map<string, Revocation>();

  return {
    async createIssuance() {},
    async getIssuance(jti) {
      return issuances.get(jti) ?? null;
    },
    async revokeIssuance(jti, reason) {
      if (!issuances.has(jti)) {
        return null;
      }
      const existing = revocations.get(jti);
      if (existing) {
        return existing;
      }
      const revocation = {
        jti,
        revoked_at: new Date("2026-07-20T12:01:00.000Z"),
        reason,
        expires_at: issuances.get(jti)!.expires_at,
      };
      revocations.set(jti, revocation);
      return revocation;
    },
  };
}

describe("POST /revoke", () => {
  let app: ReturnType<typeof buildServer>;
  let publishRevocation: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { privateKey } = await generateKeyPair("ES256");
    publishRevocation = vi.fn(async () => undefined);
    app = buildServer({
      repository: createMemoryRepository(),
      publishRevocation,
      signCredential: createCredentialSigner({ issuer: "test-issuer", privateKey }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("revokes a known issuance with an optional reason", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "known-jti", reason: "operator requested" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jti: "known-jti",
      revoked_at: "2026-07-20T12:01:00.000Z",
      reason: "operator requested",
    });
    expect(publishRevocation).toHaveBeenCalledWith(
      expect.objectContaining({
        jti: "known-jti",
        expires_at: new Date("2026-07-20T12:05:00.000Z"),
      }),
    );
    expect(response.body).not.toContain("expires_at");
  });

  it("uses null when the optional reason is omitted", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "known-jti" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jti: "known-jti", reason: null });
  });

  it("is idempotent and preserves the first reason and timestamp", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "known-jti", reason: "first reason" },
    });
    const retry = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "known-jti", reason: "replacement reason" },
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
  });

  it.each([
    ["missing JTI", {}],
    ["blank JTI", { jti: "   " }],
    ["blank reason", { jti: "known-jti", reason: "   " }],
    ["unknown field", { jti: "known-jti", token: "sensitive-token" }],
    ["non-object body", ["known-jti"]],
  ])("returns 400 for %s", async (_name, payload) => {
    const response = await app.inject({ method: "POST", url: "/revoke", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_error" });
    expect(response.body).not.toContain("sensitive-token");
  });

  it("returns 404 for an unknown issuance", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "unknown-jti" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "issuance_not_found" });
    expect(publishRevocation).not.toHaveBeenCalled();
  });

  it("returns 503 after durable revocation when cache propagation fails, then retries", async () => {
    publishRevocation.mockRejectedValueOnce(new Error("private redis detail"));
    const failed = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "known-jti", reason: "durable reason" },
    });
    const retry = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "known-jti", reason: "replacement reason" },
    });

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "revocation_propagation_unavailable" });
    expect(failed.body).not.toContain("known-jti");
    expect(failed.body).not.toContain("private redis detail");
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ jti: "known-jti", reason: "durable reason" });
    expect(publishRevocation).toHaveBeenCalledTimes(2);
  });

  it("sanitizes repository failures without returning request data", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    await app.close();
    const repository = createMemoryRepository();
    repository.revokeIssuance = vi.fn().mockRejectedValue(
      new Error("database detail for sensitive-jti"),
    );
    app = buildServer({
      repository,
      publishRevocation: async () => undefined,
      signCredential: createCredentialSigner({ issuer: "test-issuer", privateKey }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti: "sensitive-jti", reason: "private reason" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_server_error" });
    expect(response.body).not.toContain("sensitive-jti");
    expect(response.body).not.toContain("private reason");
    expect(response.body).not.toContain("database detail");
  });
});
