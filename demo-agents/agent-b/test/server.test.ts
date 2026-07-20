import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialVerifier,
  type DecisionObserverErrorHandler,
  type IsRevoked,
} from "@agent-cred/verifier-sdk";
import { createPostgresAuditObserver } from "../src/audit.js";
import { assertDatabaseReady, buildServer } from "../src/server.js";

const nowSeconds = Math.floor(Date.now() / 1_000);

describe("Agent B", () => {
  const apps: ReturnType<typeof buildServer>[] = [];
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeEach(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("ES256"));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function token(scope: string[]): Promise<string> {
    return new SignJWT({
      principal: "demo-principal",
      scope,
      delegation_chain: [],
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer("test-issuer")
      .setSubject("agent-a")
      .setAudience("agent-b")
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 300)
      .setJti("test-jti")
      .sign(privateKey);
  }

  function createApp(
    onDecision: ReturnType<typeof createPostgresAuditObserver>,
    onDecisionError?: DecisionObserverErrorHandler,
  ) {
    const isRevoked = vi.fn<IsRevoked>().mockResolvedValue(false);
    const verifyCredential = createCredentialVerifier({
      publicKey,
      issuer: "test-issuer",
      isRevoked,
      onDecision,
      onDecisionError,
    });
    const app = buildServer({ verifyCredential });
    apps.push(app);
    return app;
  }

  it("returns the quote to a credential with the exact required scope", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const app = createApp(createPostgresAuditObserver({ query } as never));
    const credential = await token(["read:quote:basic"]);

    const response = await app.inject({
      method: "GET",
      url: "/get-quote",
      headers: { authorization: `Bearer ${credential}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      quote: "Trust is scoped, verified, and revocable.",
      served_to: "demo-principal",
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    ["allowed", ["read:quote:basic"], 200],
    ["scope denied", ["read:weather"], 403],
  ] as const)(
    "preserves the %s HTTP result when both audit attempts fail",
    async (_name, scope, expectedStatus) => {
      const auditError = new Error("audit database unavailable");
      const query = vi.fn().mockRejectedValue(auditError);
      const onDecisionError = vi.fn<DecisionObserverErrorHandler>();
      const app = createApp(
        createPostgresAuditObserver({ query } as never, { retryDelayMs: 100 }),
        onDecisionError,
      );
      const credential = await token([...scope]);
      const startedAt = performance.now();

      const response = await app.inject({
        method: "GET",
        url: "/get-quote",
        headers: { authorization: `Bearer ${credential}` },
      });
      const elapsedMs = performance.now() - startedAt;

      expect(response.statusCode).toBe(expectedStatus);
      expect(query).toHaveBeenCalledTimes(2);
      expect(onDecisionError).toHaveBeenCalledWith(
        auditError,
        expect.objectContaining({
          decision: expectedStatus === 200 ? "allow" : "deny",
        }),
      );
      expect(elapsedMs).toBeGreaterThanOrEqual(90);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(response.body).not.toContain(credential);
    },
  );

  it("fails its readiness check when PostgreSQL is unavailable", async () => {
    const error = new Error("connection refused");
    const query = vi.fn().mockRejectedValue(error);

    await expect(assertDatabaseReady({ query } as never)).rejects.toBe(error);
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });
});
