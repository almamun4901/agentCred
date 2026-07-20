import { describe, expect, it, vi } from "vitest";
import type { VerificationEvent } from "@agent-cred/verifier-sdk";
import { createPostgresAuditObserver } from "../src/audit.js";

const event: VerificationEvent = {
  jti: "test-jti",
  principal: "test-principal",
  requestedAction: "read:quote:basic",
  audience: "agent-b",
  decision: "deny",
  denialReason: "scope_exceeded",
};

describe("createPostgresAuditObserver", () => {
  it("retries once after the configured delay", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce({ rowCount: 1 });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const observer = createPostgresAuditObserver({ query } as never, {
      retryDelayMs: 100,
      sleep,
    });

    await observer(event);

    expect(query).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "test-jti",
      "test-principal",
      "read:quote:basic",
      "agent-b",
      "deny",
      "scope_exceeded",
    ]);
  });

  it("rejects after exactly two failed insert attempts", async () => {
    const finalError = new Error("still unavailable");
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(finalError);
    const observer = createPostgresAuditObserver({ query } as never, {
      retryDelayMs: 0,
    });

    await expect(observer(event)).rejects.toBe(finalError);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
