import type pg from "pg";
import type { IsRevoked } from "./verify.js";

export function createPostgresRevocationChecker(
  queryable: Pick<pg.Pool, "query">,
): IsRevoked {
  return async function isRevoked(jti: string): Promise<boolean> {
    const result = await queryable.query(
      "SELECT 1 FROM revocations WHERE jti = $1 LIMIT 1",
      [jti],
    );
    return result.rowCount === 1;
  };
}
