export {
  createCredentialVerifier,
  denialReasons,
  type CredentialVerifierOptions,
  type DecisionObserver,
  type DecisionObserverErrorHandler,
  type DenialReason,
  type IsRevoked,
  type VerificationResult,
  type VerificationEvent,
  type VerifiedCredentialClaims,
  type VerifyCredential,
} from "./verify.js";
export {
  createVerifierPreHandler,
  type VerifierPreHandlerOptions,
} from "./middleware.js";
export { createPostgresRevocationChecker } from "./revocation.js";
