import type pg from "pg";
import type { DecisionObserver, VerificationEvent } from "@agent-cred/verifier-sdk";

export interface AuditObserverOptions {
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createPostgresAuditObserver(
  queryable: Pick<pg.Pool, "query">,
  options: AuditObserverOptions = {},
): DecisionObserver {
  const retryDelayMs = options.retryDelayMs ?? 100;
  const sleep = options.sleep ?? defaultSleep;

  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("retryDelayMs must be a non-negative integer");
  }

  const insert = async (event: VerificationEvent): Promise<void> => {
    await queryable.query(
      `INSERT INTO verification_log (
        jti, principal, requested_action, audience, decision, denial_reason
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.jti,
        event.principal,
        event.requestedAction,
        event.audience,
        event.decision,
        event.denialReason,
      ],
    );
  };

  return async function recordVerification(event): Promise<void> {
    try {
      await insert(event);
    } catch {
      await sleep(retryDelayMs);
      await insert(event);
    }
  };
}
