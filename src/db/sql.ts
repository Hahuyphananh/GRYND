import { getPool } from "./pool";
import type { QueryResult } from "pg";

/**
 * Tagged-template `sql` helper backed by the shared pg pool.
 *
 * Drop-in replacement for `@vercel/postgres`'s `sql`: a tagged template
 * returns a pg `QueryResult` (use `.rows` / `.rowCount`), and `sql.query`
 * runs a plain text query with params. Connection-agnostic — works against
 * Supabase, Neon, or any Postgres, since it is plain TCP via `pg`.
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

export interface Sql {
  (strings: TemplateStringsArray, ...values: SqlValue[]): Promise<QueryResult>;
  query(text: string, params?: unknown[]): Promise<QueryResult>;
}

export const sql = ((strings: TemplateStringsArray, ...values: SqlValue[]) => {
  const { text, values: params } = buildQuery(strings, ...values);
  return getPool().query(text, params);
}) as Sql;

sql.query = (text: string, params?: unknown[]) =>
  getPool().query(text, params);
