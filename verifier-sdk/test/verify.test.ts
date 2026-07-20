import { generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialVerifier,
  type DecisionObserver,
  type DecisionObserverErrorHandler,
  type IsRevoked,
} from "../src/verify.js";

const nowSeconds = Math.floor(Date.now() / 1_000);

interface TokenOverrides {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  iat?: unknown;
  exp?: unknown;
  jti?: unknown;
  principal?: unknown;
  scope?: unknown;
  delegation_chain?: unknown;
  typ?: string;
}

async function signToken(
  privateKey: CryptoKey,
  overrides: TokenOverrides = {},
): Promise<string> {
  const payload = {
    iss: "test-issuer",
    sub: "agent-a",
    aud: "agent-b",
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: "test-jti",
    principal: "company-x",
    scope: ["read:weather"],
    delegation_chain: [],
    ...overrides,
  };
  const typ = overrides.typ ?? "JWT";
  delete payload.typ;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ })
    .sign(privateKey);
}

describe("createCredentialVerifier", () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let isRevoked: ReturnType<typeof vi.fn<IsRevoked>>;

  beforeEach(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("ES256"));
    isRevoked = vi.fn<IsRevoked>().mockResolvedValue(false);
  });

  function createVerifier() {
    return createCredentialVerifier({
      publicKey,
      issuer: "test-issuer",
      isRevoked,
    });
  }

  it("allows a valid, unrevoked credential with the requested scope", async () => {
    const token = await signToken(privateKey);

    const result = await createVerifier()(token, "read:weather", "agent-b");

    expect(result).toEqual({
      decision: "allow",
      claims: {
        iss: "test-issuer",
        sub: "agent-a",
        aud: "agent-b",
        iat: nowSeconds,
        exp: nowSeconds + 300,
        jti: "test-jti",
        principal: "company-x",
        scope: ["read:weather"],
        delegation_chain: [],
      },
    });
    expect(isRevoked).toHaveBeenCalledWith("test-jti");
  });

  it("denies an expired credential", async () => {
    const token = await signToken(privateKey, {
      iat: nowSeconds - 600,
      exp: nowSeconds - 300,
    });

    await expect(createVerifier()(token, "read:weather", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "expired",
    });
    expect(isRevoked).not.toHaveBeenCalled();
  });

  it("denies a credential intended for another audience", async () => {
    const token = await signToken(privateKey, { aud: "agent-c" });

    await expect(createVerifier()(token, "read:weather", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "aud_mismatch",
    });
  });

  it("denies a credential from another issuer", async () => {
    const token = await signToken(privateKey, { iss: "other-issuer" });

    await expect(createVerifier()(token, "read:weather", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "issuer_mismatch",
    });
  });

  it("denies a revoked credential before evaluating its scope", async () => {
    isRevoked.mockResolvedValue(true);
    const token = await signToken(privateKey, { scope: ["read:other"] });

    await expect(createVerifier()(token, "read:weather", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "revoked",
    });
  });

  it("denies an action that is not an exact, case-sensitive scope match", async () => {
    const token = await signToken(privateKey, { scope: ["Read:Weather"] });

    await expect(createVerifier()(token, "read:weather", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "scope_exceeded",
    });
  });

  it("denies a tampered token without querying revocation", async () => {
    const token = await signToken(privateKey);
    const [header, payload, signature] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined) {
      throw new Error("test helper produced a malformed JWT");
    }
    const tamperedSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    const tamperedToken = `${header}.${payload}.${tamperedSignature}`;

    await expect(
      createVerifier()(tamperedToken, "read:weather", "agent-b"),
    ).resolves.toEqual({ decision: "deny", reason: "invalid_signature" });
    expect(isRevoked).not.toHaveBeenCalled();
  });

  it.each([
    ["missing principal", { principal: undefined }],
    ["empty scope", { scope: [] }],
    ["non-string scope", { scope: [42] }],
    ["array audience", { aud: ["agent-b"] }],
    ["missing expiration", { exp: undefined }],
    ["non-numeric expiration", { exp: "later" }],
    ["expiration before issuance", { iat: nowSeconds + 200, exp: nowSeconds + 100 }],
    ["wrong token type", { typ: "at+jwt" }],
  ])("denies invalid claims for %s", async (_name, overrides) => {
    const token = await signToken(privateKey, overrides);

    await expect(createVerifier()(token, "read:weather", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "invalid_claims",
    });
    expect(isRevoked).not.toHaveBeenCalled();
  });

  it("fails closed when the revocation store is unavailable", async () => {
    isRevoked.mockRejectedValue(new Error("database secret"));
    const token = await signToken(privateKey);

    await expect(createVerifier()(token, "read:weather", "agent-b")).resolves.toEqual({
      decision: "deny",
      reason: "verification_unavailable",
    });
  });

  it("observes allowed and scope-denied decisions with trusted identifiers", async () => {
    const onDecision = vi.fn<DecisionObserver>();
    const verifier = createCredentialVerifier({
      publicKey,
      issuer: "test-issuer",
      isRevoked,
      onDecision,
    });
    const allowedToken = await signToken(privateKey);
    const deniedToken = await signToken(privateKey, { scope: ["read:other"] });

    await verifier(allowedToken, "read:weather", "agent-b");
    await verifier(deniedToken, "read:weather", "agent-b");

    expect(onDecision).toHaveBeenNthCalledWith(1, {
      jti: "test-jti",
      principal: "company-x",
      requestedAction: "read:weather",
      audience: "agent-b",
      decision: "allow",
      denialReason: null,
    });
    expect(onDecision).toHaveBeenNthCalledWith(2, {
      jti: "test-jti",
      principal: "company-x",
      requestedAction: "read:weather",
      audience: "agent-b",
      decision: "deny",
      denialReason: "scope_exceeded",
    });
  });

  it("does not expose decoded identifiers from an untrusted credential", async () => {
    const onDecision = vi.fn<DecisionObserver>();
    const token = await signToken(privateKey, { aud: "agent-c" });
    const verifier = createCredentialVerifier({
      publicKey,
      issuer: "test-issuer",
      isRevoked,
      onDecision,
    });

    await verifier(token, "read:weather", "agent-b");

    expect(onDecision).toHaveBeenCalledWith({
      jti: null,
      principal: null,
      requestedAction: "read:weather",
      audience: "agent-b",
      decision: "deny",
      denialReason: "aud_mismatch",
    });
  });

  it("contains observer and observer-error failures after finalizing the decision", async () => {
    const observerError = new Error("audit unavailable");
    const onDecision = vi.fn<DecisionObserver>().mockRejectedValue(observerError);
    const onDecisionError = vi
      .fn<DecisionObserverErrorHandler>()
      .mockRejectedValue(new Error("logger unavailable"));
    const token = await signToken(privateKey);
    const verifier = createCredentialVerifier({
      publicKey,
      issuer: "test-issuer",
      isRevoked,
      onDecision,
      onDecisionError,
    });

    const result = await verifier(token, "read:weather", "agent-b");

    expect(result).toMatchObject({ decision: "allow" });
    expect(onDecisionError).toHaveBeenCalledWith(observerError, {
      jti: "test-jti",
      principal: "company-x",
      requestedAction: "read:weather",
      audience: "agent-b",
      decision: "allow",
      denialReason: null,
    });
  });

  it("rejects a blank trusted issuer during configuration", () => {
    expect(() =>
      createCredentialVerifier({ publicKey, issuer: "  ", isRevoked }),
    ).toThrow("issuer must be a non-blank string");
  });
});
