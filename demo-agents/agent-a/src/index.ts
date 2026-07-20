import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_SCOPE = "read:quote:basic";
const OVERREACH_SCOPE = "read:weather";
const EXPECTED_QUOTE = "Trust is scoped, verified, and revocable.";

type Fetch = typeof globalThis.fetch;

export interface DemoOptions {
  issuerBaseUrl?: string;
  agentBBaseUrl?: string;
  timeoutMs?: number;
  fetch?: Fetch;
  generateRunId?: () => string;
  log?: (message: string) => void;
}

export interface DemoResult {
  runId: string;
  principal: string;
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON (HTTP ${response.status})`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const issuerBaseUrl = withoutTrailingSlash(
    options.issuerBaseUrl ?? "http://127.0.0.1:3000",
  );
  const agentBBaseUrl = withoutTrailingSlash(
    options.agentBBaseUrl ?? "http://127.0.0.1:3001",
  );
  const timeoutMs = options.timeoutMs ?? 5_000;
  const runId = (options.generateRunId ?? randomUUID)();
  const principal = `phase3-demo-${runId}`;
  const log = options.log ?? console.log;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }

  log(`run_id=${runId}`);
  log(`principal=${principal}`);

  const issue = async (scope: string): Promise<string> => {
    const response = await fetchRequest(`${issuerBaseUrl}/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-a",
        principal,
        scope: [scope],
        aud: "agent-b",
        ttl: 300,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readJson(response, "Issuer");
    if (
      response.status !== 200 ||
      !isRecord(body) ||
      typeof body.token !== "string" ||
      body.token.length === 0
    ) {
      throw new Error(`Issuer rejected the ${scope} credential (HTTP ${response.status})`);
    }
    return body.token;
  };

  const callAgentB = async (token: string): Promise<Response> =>
    fetchRequest(`${agentBBaseUrl}/get-quote`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

  const overreachToken = await issue(OVERREACH_SCOPE);
  const deniedResponse = await callAgentB(overreachToken);
  const deniedBody = await readJson(deniedResponse, "Agent B denial");
  if (
    deniedResponse.status !== 403 ||
    !isRecord(deniedBody) ||
    deniedBody.error !== "credential_denied" ||
    deniedBody.reason !== "scope_exceeded"
  ) {
    throw new Error(
      `Expected Agent B to deny overreach with 403 scope_exceeded; received HTTP ${deniedResponse.status}`,
    );
  }
  log("DENIED 403 scope_exceeded (read:weather cannot read a quote)");

  const allowedToken = await issue(REQUIRED_SCOPE);
  const allowedResponse = await callAgentB(allowedToken);
  const allowedBody = await readJson(allowedResponse, "Agent B success");
  if (
    allowedResponse.status !== 200 ||
    !isRecord(allowedBody) ||
    allowedBody.quote !== EXPECTED_QUOTE ||
    allowedBody.served_to !== principal
  ) {
    throw new Error(
      `Expected Agent B to allow read:quote:basic; received HTTP ${allowedResponse.status}`,
    );
  }
  log(`ALLOWED 200 ${EXPECTED_QUOTE}`);
  log("Phase 3 demo passed: attempted overreach was blocked, correct scope was allowed.");

  return { runId, principal };
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  runDemo({
    issuerBaseUrl: process.env.ISSUER_BASE_URL,
    agentBBaseUrl: process.env.AGENT_B_BASE_URL,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Phase 3 demo failed");
    process.exitCode = 1;
  });
}
