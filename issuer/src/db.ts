import pg from "pg";
import type { CredentialClaims } from "./sign.js";

const { Pool } = pg;

export interface Issuance {
  jti: string;
  agent_id: string;
  principal: string;
  scope: string[];
  audience: string;
  issued_at: Date;
  expires_at: Date;
  delegation_chain: string[];
}

export interface Revocation {
  jti: string;
  revoked_at: Date;
  reason: string | null;
}

export interface IssuanceRepository {
  createIssuance(claims: CredentialClaims): Promise<void>;
  getIssuance(jti: string): Promise<Issuance | null>;
  revokeIssuance(jti: string, reason: string | null): Promise<Revocation | null>;
}

export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString });
}

export function createIssuanceRepository(pool: pg.Pool): IssuanceRepository {
  return {
    async createIssuance(claims) {
      await pool.query(
        `INSERT INTO issuances (
          jti, agent_id, principal, scope, audience, issued_at, expires_at, delegation_chain
        ) VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8::jsonb)`,
        [
          claims.jti,
          claims.sub,
          claims.principal,
          claims.scope,
          claims.aud,
          claims.iat,
          claims.exp,
          JSON.stringify(claims.delegation_chain),
        ],
      );
    },

    async getIssuance(jti) {
      const result = await pool.query<Issuance>(
        `SELECT jti, agent_id, principal, scope, audience, issued_at, expires_at,
                delegation_chain
         FROM issuances
         WHERE jti = $1`,
        [jti],
      );
      return result.rows[0] ?? null;
    },

    async revokeIssuance(jti, reason) {
      const result = await pool.query<Revocation>(
        `INSERT INTO revocations AS existing (jti, reason)
         SELECT jti, $2
         FROM issuances
         WHERE jti = $1
         ON CONFLICT (jti) DO UPDATE SET jti = existing.jti
         RETURNING jti, revoked_at, reason`,
        [jti, reason],
      );
      return result.rows[0] ?? null;
    },
  };
}
