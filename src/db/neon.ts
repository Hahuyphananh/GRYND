import { getPool } from "./pool";

/**
 * `getNeonSql()` returns a tagged-template `sql` helper that resolves to
 * the result ROWS directly (an array of objects), matching the API of the
 * `neon()` HTTP helper it replaces. It now runs over the shared pg pool
 * (plain TCP), so it works against any Postgres provider — Supabase,
 * Neon, or local — instead of Neon's HTTP endpoint.
 *
 * Usage is unchanged for callers:
 *   const sql = getNeonSql();
 *   const rows = await sql`SELECT * FROM users`;
 */

type SqlValue = string | number | boolean | null | Date | unknown[] | undefined;

function buildQuery(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
): { text: string; values: SqlValue[] } {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    text += `$${i + 1}` + (strings[i + 1] ?? "");
  }
  return { text, values };
}

export interface NeonSql {
  (strings: TemplateStringsArray, ...values: SqlValue[]): Promise<any[]>;
  query(text: string, params?: unknown[]): Promise<any[]>;
}

export function getNeonSql(): NeonSql {
  const pool = getPool();

  const sql = (async (strings: TemplateStringsArray, ...values: SqlValue[]) => {
    const { text, values: params } = buildQuery(strings, ...values);
    const result = await pool.query(text, params);
    return result.rows;
  }) as NeonSql;

  sql.query = async (text: string, params?: unknown[]) => {
    const result = await pool.query(text, params);
    return result.rows;
  };

  return sql;
}
