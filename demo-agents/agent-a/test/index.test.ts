import { describe, expect, it, vi } from "vitest";
import { runDemo } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runDemo", () => {
  it("runs the deny-then-allow sequence without printing credentials", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: "sensitive-overreach-token" }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "credential_denied", reason: "scope_exceeded" },
          403,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ token: "sensitive-allowed-token" }))
      .mockResolvedValueOnce(
        jsonResponse({
          quote: "Trust is scoped, verified, and revocable.",
          served_to: "phase3-demo-test-run",
        }),
      );
    const log = vi.fn<(message: string) => void>();

    const result = await runDemo({
      fetch,
      generateRunId: () => "test-run",
      log,
    });

    expect(result).toEqual({
      runId: "test-run",
      principal: "phase3-demo-test-run",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      principal: "phase3-demo-test-run",
      scope: ["read:weather"],
      aud: "agent-b",
      ttl: 300,
    });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      scope: ["read:quote:basic"],
    });
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer sensitive-overreach-token",
    });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("DENIED 403 scope_exceeded");
    expect(output).toContain("ALLOWED 200");
    expect(output).not.toContain("sensitive-overreach-token");
    expect(output).not.toContain("sensitive-allowed-token");
  });

  it("stops before requesting a second credential when overreach is not denied", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: "credential" }))
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }, 200));

    await expect(
      runDemo({ fetch, generateRunId: () => "bad-run", log: vi.fn() }),
    ).rejects.toThrow("Expected Agent B to deny overreach");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed issuer responses without exposing their contents", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "internal detail" }, 500));

    await expect(
      runDemo({ fetch, generateRunId: () => "issuer-fail", log: vi.fn() }),
    ).rejects.toThrow("Issuer rejected the read:weather credential (HTTP 500)");
  });
});
