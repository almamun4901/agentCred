import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PRINCIPAL = "phase6-demo";
const SCOPE = "read:quote:basic";

function baseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`Expected a JSON object from HTTP ${response.status}`);
  }
  return body as Record<string, unknown>;
}

export async function runRateLimitDemo(options: {
  issuerBaseUrl?: string;
  agentBBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
} = {}): Promise<void> {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const issuer = baseUrl(options.issuerBaseUrl ?? "http://127.0.0.1:3000");
  const agentB = baseUrl(options.agentBBaseUrl ?? "http://127.0.0.1:3001");
  const log = options.log ?? console.log;

  const issue = async (): Promise<string> => {
    const response = await fetchRequest(`${issuer}/issue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent-a",
        principal: PRINCIPAL,
        scope: [SCOPE],
        aud: "agent-b",
        ttl: 300,
      }),
    });
    const body = await readBody(response);
    if (response.status !== 200 || typeof body.token !== "string") {
      throw new Error(`Credential issuance failed with HTTP ${response.status}`);
    }
    return body.token;
  };

  const tokens = [await issue(), await issue()];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetchRequest(`${agentB}/get-quote`, {
      headers: { authorization: `Bearer ${tokens[(attempt - 1) % 2]}` },
    });
    const body = await readBody(response);
    const expectedStatus = attempt <= 3 ? 200 : 429;
    if (response.status !== expectedStatus) {
      throw new Error(
        `Request ${attempt} expected HTTP ${expectedStatus}, received ${response.status}`,
      );
    }
    if (attempt === 4 && body.reason !== "rate_limited") {
      throw new Error("Fourth request was not denied as rate_limited");
    }
    log(`request=${attempt} token=${attempt % 2 === 1 ? 1 : 2} status=${response.status}`);
  }
  log("Phase 6 demo passed: token rotation did not bypass the 3-request budget.");
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  runRateLimitDemo({
    issuerBaseUrl: process.env.ISSUER_BASE_URL,
    agentBBaseUrl: process.env.AGENT_B_BASE_URL,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Phase 6 demo failed");
    process.exitCode = 1;
  });
}
