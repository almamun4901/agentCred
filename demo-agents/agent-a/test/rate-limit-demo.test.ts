import { describe, expect, it, vi } from "vitest";
import { runRateLimitDemo } from "../src/rate-limit-demo.js";

describe("runRateLimitDemo", () => {
  it("proves that two rotated credentials share a three-request budget", async () => {
    const responses = [
      new Response(JSON.stringify({ token: "token-one" }), { status: 200 }),
      new Response(JSON.stringify({ token: "token-two" }), { status: 200 }),
      new Response(JSON.stringify({ quote: "one" }), { status: 200 }),
      new Response(JSON.stringify({ quote: "two" }), { status: 200 }),
      new Response(JSON.stringify({ quote: "three" }), { status: 200 }),
      new Response(JSON.stringify({ reason: "rate_limited" }), {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    ];
    const fetchRequest = vi.fn(async () => responses.shift()!);
    const log = vi.fn();

    await runRateLimitDemo({ fetch: fetchRequest as typeof fetch, log });

    const protectedCalls = fetchRequest.mock.calls.slice(2);
    expect(
      protectedCalls.map((call) =>
        (call[1] as RequestInit).headers,
      ),
    ).toEqual([
      { authorization: "Bearer token-one" },
      { authorization: "Bearer token-two" },
      { authorization: "Bearer token-one" },
      { authorization: "Bearer token-two" },
    ]);
    expect(log).toHaveBeenLastCalledWith(
      "Phase 6 demo passed: token rotation did not bypass the 3-request budget.",
    );
  });
});
