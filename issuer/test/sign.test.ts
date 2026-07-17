import { generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createCredentialSigner } from "../src/sign.js";

describe("createCredentialSigner", () => {
  it("signs an ES256 credential that verifies with the matching public key", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const signCredential = createCredentialSigner({
      issuer: "test-issuer",
      privateKey,
      now: () => 1_700_000_000_000,
      generateJti: () => "fixed-jti",
    });

    const { token, claims } = await signCredential({
      agentId: "agent-a",
      principal: "company-x",
      scope: ["read:weather"],
      audience: "agent-b",
      ttlSeconds: 300,
    });
    const verified = await jwtVerify(token, publicKey, {
      algorithms: ["ES256"],
      issuer: "test-issuer",
      audience: "agent-b",
      currentDate: new Date(1_700_000_001_000),
    });

    expect(verified.protectedHeader).toEqual({ alg: "ES256", typ: "JWT" });
    expect(verified.payload).toMatchObject(claims);
    expect(claims).toEqual({
      iss: "test-issuer",
      sub: "agent-a",
      aud: "agent-b",
      iat: 1_700_000_000,
      exp: 1_700_000_300,
      jti: "fixed-jti",
      principal: "company-x",
      scope: ["read:weather"],
      delegation_chain: [],
    });
    expect(claims.exp).toBe(claims.iat + 300);
  });

  it("generates a different JTI for each credential", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const signCredential = createCredentialSigner({
      issuer: "test-issuer",
      privateKey,
    });
    const input = {
      agentId: "agent-a",
      principal: "company-x",
      scope: ["read:weather"],
      audience: "agent-b",
      ttlSeconds: 300,
    };

    const first = await signCredential(input);
    const second = await signCredential(input);

    expect(first.claims.jti).not.toBe(second.claims.jti);
  });
});
