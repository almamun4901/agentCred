import { randomUUID } from "node:crypto";
import { generateKeyPair, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIssuanceRepository, createPool } from "../src/db.js";
import { buildServer } from "../src/server.js";
import { createCredentialSigner } from "../src/sign.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://agentcred:agentcred-local-only@localhost:5432/agentcred";

describe("issuer PostgreSQL integration", () => {
  const pool = createPool(databaseUrl);
  const createdJtis: string[] = [];
  let app: ReturnType<typeof buildServer>;
  let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];

  beforeAll(async () => {
    const keys = await generateKeyPair("ES256");
    publicKey = keys.publicKey;
    app = buildServer({
      repository: createIssuanceRepository(pool),
      signCredential: createCredentialSigner({
        issuer: "integration-test-issuer",
        privateKey: keys.privateKey,
        generateJti: () => {
          const jti = `integration-${randomUUID()}`;
          createdJtis.push(jti);
          return jti;
        },
      }),
    });
  });

  afterAll(async () => {
    if (createdJtis.length > 0) {
      await pool.query("DELETE FROM issuances WHERE jti = ANY($1::text[])", [createdJtis]);
    }
    await app.close();
    await pool.end();
  });

  it("issues, persists, verifies, and retrieves a credential", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/issue",
      payload: {
        agent_id: "integration-agent",
        principal: "integration-principal",
        scope: ["read:weather"],
        aud: "integration-audience",
        ttl: 300,
      },
    });

    expect(issued.statusCode).toBe(200);
    const { token } = issued.json<{ token: string }>();
    const verified = await jwtVerify(token, publicKey, {
      algorithms: ["ES256"],
      issuer: "integration-test-issuer",
      audience: "integration-audience",
    });
    const jti = verified.payload.jti;
    expect(jti).toMatch(/^integration-/);

    const databaseRow = await pool.query(
      "SELECT * FROM issuances WHERE jti = $1",
      [jti],
    );
    expect(databaseRow.rowCount).toBe(1);
    expect(databaseRow.rows[0]).toMatchObject({
      jti,
      agent_id: "integration-agent",
      principal: "integration-principal",
      scope: ["read:weather"],
      audience: "integration-audience",
      delegation_chain: [],
    });
    expect(Math.floor(databaseRow.rows[0].issued_at.getTime() / 1_000)).toBe(
      verified.payload.iat,
    );
    expect(Math.floor(databaseRow.rows[0].expires_at.getTime() / 1_000)).toBe(
      verified.payload.exp,
    );

    const fetched = await app.inject({ method: "GET", url: `/issuances/${jti}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ jti, agent_id: "integration-agent" });
  });

  it("returns 400 without scope and creates no issuance", async () => {
    const before = createdJtis.length;
    const response = await app.inject({
      method: "POST",
      url: "/issue",
      payload: {
        agent_id: "integration-agent",
        principal: "integration-principal",
        aud: "integration-audience",
        ttl: 300,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(createdJtis).toHaveLength(before);
  });
});
