import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateKeyPair, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialVerifier,
  createPostgresRevocationChecker,
  type VerificationEvent,
} from "@agent-cred/verifier-sdk";
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
      await pool.query("DELETE FROM verification_log WHERE jti = ANY($1::text[])", [
        createdJtis,
      ]);
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

  it("revokes an issuance idempotently and preserves first-write evidence", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/issue",
      payload: {
        agent_id: "integration-agent",
        principal: "integration-revocation-principal",
        scope: ["read:quote:basic"],
        aud: "agent-b",
        ttl: 300,
      },
    });
    expect(issued.statusCode).toBe(200);
    const { token } = issued.json<{ token: string }>();
    const verified = await jwtVerify(token, publicKey, {
      algorithms: ["ES256"],
      issuer: "integration-test-issuer",
      audience: "agent-b",
    });
    const jti = verified.payload.jti!;

    const [first, concurrentRetry] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/revoke",
        payload: { jti, reason: "first reason" },
      }),
      app.inject({
        method: "POST",
        url: "/revoke",
        payload: { jti, reason: "competing reason" },
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(concurrentRetry.statusCode).toBe(200);
    expect(concurrentRetry.json()).toEqual(first.json());
    const rows = await pool.query(
      "SELECT jti, revoked_at, reason FROM revocations WHERE jti = $1",
      [jti],
    );
    expect(rows.rowCount).toBe(1);
    expect({
      ...rows.rows[0],
      revoked_at: rows.rows[0].revoked_at.toISOString(),
    }).toEqual(first.json());
  });

  it("returns 404 and creates no revocation for an unknown JTI", async () => {
    const jti = `unknown-${randomUUID()}`;
    const response = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti, reason: "should not be stored" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "issuance_not_found" });
    const rows = await pool.query("SELECT 1 FROM revocations WHERE jti = $1", [jti]);
    expect(rows.rowCount).toBe(0);
  });

  it("permits revocation after an issuance has expired", async () => {
    const jti = `expired-${randomUUID()}`;
    createdJtis.push(jti);
    await pool.query(
      `INSERT INTO issuances (
        jti, agent_id, principal, scope, audience, issued_at, expires_at
      ) VALUES (
        $1, 'integration-agent', 'expired-principal', ARRAY['read:quote:basic'],
        'agent-b', CURRENT_TIMESTAMP - INTERVAL '5 minutes',
        CURRENT_TIMESTAMP - INTERVAL '1 minute'
      )`,
      [jti],
    );

    const response = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti, reason: "post-expiry evidence" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jti,
      reason: "post-expiry evidence",
    });
  });

  it("allows a fresh token, then denies and audits it after API revocation", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/issue",
      payload: {
        agent_id: "integration-agent",
        principal: "integration-lifecycle-principal",
        scope: ["read:quote:basic"],
        aud: "agent-b",
        ttl: 300,
      },
    });
    expect(issued.statusCode).toBe(200);
    const { token } = issued.json<{ token: string }>();
    const decoded = await jwtVerify(token, publicKey, {
      algorithms: ["ES256"],
      issuer: "integration-test-issuer",
      audience: "agent-b",
    });
    const jti = decoded.payload.jti!;
    const onDecision = async (event: VerificationEvent): Promise<void> => {
      await pool.query(
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
    const verifyCredential = createCredentialVerifier({
      publicKey,
      issuer: "integration-test-issuer",
      isRevoked: createPostgresRevocationChecker(pool),
      onDecision,
    });

    await expect(
      verifyCredential(token, "read:quote:basic", "agent-b"),
    ).resolves.toMatchObject({ decision: "allow" });
    const revoked = await app.inject({
      method: "POST",
      url: "/revoke",
      payload: { jti, reason: "lifecycle integration test" },
    });
    expect(revoked.statusCode).toBe(200);
    await expect(
      verifyCredential(token, "read:quote:basic", "agent-b"),
    ).resolves.toEqual({ decision: "deny", reason: "revoked" });

    const auditRows = await pool.query(
      `SELECT decision, denial_reason
       FROM verification_log
       WHERE jti = $1
       ORDER BY id`,
      [jti],
    );
    expect(auditRows.rows).toEqual([
      { decision: "allow", denial_reason: null },
      { decision: "deny", denial_reason: "revoked" },
    ]);
  });

  it("reports only recent denials grouped by reason", async () => {
    const reportId = randomUUID();
    const recentReason = `report-recent-${reportId}`;
    const secondReason = `report-second-${reportId}`;
    const jtis = [0, 1, 2, 3, 4].map((index) => `report-${reportId}-${index}`);
    try {
      await pool.query(
        `INSERT INTO verification_log (
          jti, requested_action, audience, decision, denial_reason, verified_at
        ) VALUES
          ($1, 'report:test', 'report', 'deny', $6, CURRENT_TIMESTAMP - INTERVAL '30 minutes'),
          ($2, 'report:test', 'report', 'deny', $6, CURRENT_TIMESTAMP - INTERVAL '10 minutes'),
          ($3, 'report:test', 'report', 'deny', $7, CURRENT_TIMESTAMP - INTERVAL '5 minutes'),
          ($4, 'report:test', 'report', 'deny', $6, CURRENT_TIMESTAMP - INTERVAL '2 hours'),
          ($5, 'report:test', 'report', 'allow', NULL, CURRENT_TIMESTAMP - INTERVAL '1 minute')`,
        [...jtis, recentReason, secondReason],
      );
      const reportSql = await readFile(
        new URL("../../db/reports/denials-last-hour.sql", import.meta.url),
        "utf8",
      );
      const report = await pool.query(reportSql);

      expect(
        report.rows
          .filter((row) => row.denial_reason.includes(reportId))
          .map((row) => ({ ...row, denial_count: Number(row.denial_count) })),
      ).toEqual([
        expect.objectContaining({ denial_reason: recentReason, denial_count: 2 }),
        expect.objectContaining({ denial_reason: secondReason, denial_count: 1 }),
      ]);
    } finally {
      await pool.query("DELETE FROM verification_log WHERE jti = ANY($1::text[])", [
        jtis,
      ]);
    }
  });
});
