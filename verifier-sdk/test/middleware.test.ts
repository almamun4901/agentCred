import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifierPreHandler } from "../src/middleware.js";
import type {
  VerificationResult,
  VerifiedCredentialClaims,
  VerifyCredential,
} from "../src/verify.js";

const claims: VerifiedCredentialClaims = {
  iss: "test-issuer",
  sub: "agent-a",
  aud: "agent-b",
  iat: 1_700_000_000,
  exp: 1_700_000_300,
  jti: "test-jti",
  principal: "company-x",
  scope: ["read:weather"],
  delegation_chain: [],
};

function buildProtectedApp(result: VerificationResult) {
  const verifyCredential = vi.fn<VerifyCredential>().mockResolvedValue(result);
  const handler = vi.fn(async (request: { credential?: VerifiedCredentialClaims }) => ({
    subject: request.credential?.sub,
  }));
  const app = Fastify();
  app.get(
    "/protected",
    {
      preHandler: createVerifierPreHandler({
        verifyCredential,
        requestedAction: "read:weather",
        expectedAudience: "agent-b",
      }),
    },
    handler,
  );
  return { app, handler, verifyCredential };
}

describe("createVerifierPreHandler", () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("passes a bearer token to the verifier and attaches allowed claims", async () => {
    const setup = buildProtectedApp({ decision: "allow", claims });
    apps.push(setup.app);

    const response = await setup.app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer safe-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subject: "agent-a" });
    expect(setup.verifyCredential).toHaveBeenCalledWith(
      "safe-token",
      "read:weather",
      "agent-b",
    );
    expect(setup.handler).toHaveBeenCalledOnce();
  });

  it.each([undefined, "Basic abc", "Bearer", "Bearer token with-spaces"])(
    "returns 401 and skips the route for a missing or malformed header: %s",
    async (authorization) => {
      const setup = buildProtectedApp({ decision: "allow", claims });
      apps.push(setup.app);

      const response = await setup.app.inject({
        method: "GET",
        url: "/protected",
        headers: authorization === undefined ? {} : { authorization },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toEqual({
        error: "credential_denied",
        reason: "missing_credential",
      });
      expect(setup.verifyCredential).not.toHaveBeenCalled();
      expect(setup.handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["scope_exceeded", 403],
    ["verification_unavailable", 503],
    ["invalid_signature", 401],
    ["expired", 401],
    ["revoked", 401],
  ] as const)("maps %s to HTTP %i and short-circuits", async (reason, statusCode) => {
    const setup = buildProtectedApp({ decision: "deny", reason });
    apps.push(setup.app);
    const token = "sensitive-bearer-token";

    const response = await setup.app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error: "credential_denied", reason });
    expect(response.body).not.toContain(token);
    expect(setup.handler).not.toHaveBeenCalled();
  });

  it("maps a rate limit denial to 429 with a retry delay", async () => {
    const setup = buildProtectedApp({
      decision: "deny",
      reason: "rate_limited",
      retryAfterSeconds: 17,
    });
    apps.push(setup.app);

    const response = await setup.app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer safe-token" },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.json()).toEqual({
      error: "credential_denied",
      reason: "rate_limited",
    });
    expect(setup.handler).not.toHaveBeenCalled();
  });
});
