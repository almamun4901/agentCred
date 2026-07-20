import { errors, jwtVerify, type JWTPayload } from "jose";

export const denialReasons = [
  "invalid_signature",
  "expired",
  "issuer_mismatch",
  "aud_mismatch",
  "invalid_claims",
  "revoked",
  "scope_exceeded",
  "verification_unavailable",
] as const;

export type DenialReason = (typeof denialReasons)[number];

export interface VerifiedCredentialClaims {
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

export type VerificationResult =
  | { decision: "allow"; claims: VerifiedCredentialClaims }
  | { decision: "deny"; reason: DenialReason };

export type IsRevoked = (jti: string) => Promise<boolean>;

export interface VerificationEvent {
  readonly jti: string | null;
  readonly principal: string | null;
  readonly requestedAction: string;
  readonly audience: string;
  readonly decision: "allow" | "deny";
  readonly denialReason: DenialReason | null;
}

export type DecisionObserver = (event: VerificationEvent) => Promise<void> | void;
export type DecisionObserverErrorHandler = (
  error: unknown,
  event: VerificationEvent,
) => Promise<void> | void;

export interface CredentialVerifierOptions {
  publicKey: CryptoKey;
  issuer: string;
  isRevoked: IsRevoked;
  onDecision?: DecisionObserver;
  onDecisionError?: DecisionObserverErrorHandler;
}

export type VerifyCredential = (
  token: string,
  requestedAction: string,
  expectedAudience: string,
) => Promise<VerificationResult>;

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonBlankStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => isNonBlankString(item))
  );
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function toVerifiedClaims(payload: JWTPayload): VerifiedCredentialClaims | null {
  if (
    !isNonBlankString(payload.iss) ||
    !isNonBlankString(payload.sub) ||
    !isNonBlankString(payload.aud) ||
    !isInteger(payload.iat) ||
    !isInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    !isNonBlankString(payload.jti) ||
    !isNonBlankString(payload.principal) ||
    !isNonBlankStringArray(payload.scope) ||
    payload.scope.length === 0 ||
    !isNonBlankStringArray(payload.delegation_chain)
  ) {
    return null;
  }

  return {
    iss: payload.iss,
    sub: payload.sub,
    aud: payload.aud,
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.jti,
    principal: payload.principal,
    scope: [...payload.scope],
    delegation_chain: [...payload.delegation_chain],
  };
}

function mapJoseError(error: unknown): DenialReason {
  if (error instanceof errors.JWTExpired) {
    return "expired";
  }

  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") {
      return "aud_mismatch";
    }
    if (error.claim === "iss") {
      return "issuer_mismatch";
    }
    return "invalid_claims";
  }

  return "invalid_signature";
}

async function observeDecision(
  options: CredentialVerifierOptions,
  event: VerificationEvent,
): Promise<void> {
  if (options.onDecision === undefined) {
    return;
  }

  try {
    await options.onDecision(event);
  } catch (error: unknown) {
    try {
      await options.onDecisionError?.(error, event);
    } catch {
      // Observation is deliberately isolated from the finalized auth decision.
    }
  }
}

export function createCredentialVerifier(
  options: CredentialVerifierOptions,
): VerifyCredential {
  if (!isNonBlankString(options.issuer)) {
    throw new Error("issuer must be a non-blank string");
  }

  return async function verifyCredential(
    token,
    requestedAction,
    expectedAudience,
  ) {
    const finalize = async (
      result: VerificationResult,
      claims: VerifiedCredentialClaims | null,
    ): Promise<VerificationResult> => {
      const event: VerificationEvent = Object.freeze({
        jti: claims?.jti ?? null,
        principal: claims?.principal ?? null,
        requestedAction,
        audience: expectedAudience,
        decision: result.decision,
        denialReason: result.decision === "deny" ? result.reason : null,
      });
      await observeDecision(options, event);
      return result;
    };

    if (
      !isNonBlankString(token) ||
      !isNonBlankString(requestedAction) ||
      !isNonBlankString(expectedAudience)
    ) {
      return finalize({ decision: "deny", reason: "invalid_claims" }, null);
    }

    let payload: JWTPayload;
    let typ: string | undefined;
    try {
      const verified = await jwtVerify(token, options.publicKey, {
        algorithms: ["ES256"],
        issuer: options.issuer,
        audience: expectedAudience,
        clockTolerance: 0,
      });
      payload = verified.payload;
      typ = verified.protectedHeader.typ;
    } catch (error: unknown) {
      return finalize({ decision: "deny", reason: mapJoseError(error) }, null);
    }

    const claims = toVerifiedClaims(payload);
    if (typ !== "JWT" || claims === null) {
      return finalize({ decision: "deny", reason: "invalid_claims" }, null);
    }

    let revoked: boolean;
    try {
      revoked = await options.isRevoked(claims.jti);
    } catch {
      return finalize(
        { decision: "deny", reason: "verification_unavailable" },
        claims,
      );
    }

    if (revoked) {
      return finalize({ decision: "deny", reason: "revoked" }, claims);
    }

    if (!claims.scope.includes(requestedAction)) {
      return finalize({ decision: "deny", reason: "scope_exceeded" }, claims);
    }

    return finalize({ decision: "allow", claims }, claims);
  };
}
