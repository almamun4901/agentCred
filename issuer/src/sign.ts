import { randomUUID } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

export interface CredentialClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  principal: string;
  scope: string[];
  delegation_chain: string[];
}

export interface SignCredentialInput {
  agentId: string;
  principal: string;
  scope: string[];
  audience: string;
  ttlSeconds: number;
}

export interface CredentialSignerOptions {
  issuer: string;
  privateKey: CryptoKey;
  now?: () => number;
  generateJti?: () => string;
}

export interface SignedCredential {
  token: string;
  claims: CredentialClaims;
}

export async function importSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  return importPKCS8(privateKeyPem, "ES256");
}

export function createCredentialSigner(options: CredentialSignerOptions) {
  const now = options.now ?? (() => Date.now());
  const generateJti = options.generateJti ?? randomUUID;

  return async function signCredential(
    input: SignCredentialInput,
  ): Promise<SignedCredential> {
    const issuedAt = Math.floor(now() / 1_000);
    const claims: CredentialClaims = {
      iss: options.issuer,
      sub: input.agentId,
      aud: input.audience,
      iat: issuedAt,
      exp: issuedAt + input.ttlSeconds,
      jti: generateJti(),
      principal: input.principal,
      scope: [...input.scope],
      delegation_chain: [],
    };

    const token = await new SignJWT({
      principal: claims.principal,
      scope: claims.scope,
      delegation_chain: claims.delegation_chain,
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer(claims.iss)
      .setSubject(claims.sub)
      .setAudience(claims.aud)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .setJti(claims.jti)
      .sign(options.privateKey);

    return { token, claims };
  };
}

export type CredentialSigner = ReturnType<typeof createCredentialSigner>;
