/**
 * Crash Arena — shared error helpers.
 *
 * The crash_arena_tables.host_id column is added by migration
 * `0057_crash_arena_host.sql`. Because this project applies raw SQL
 * migrations manually (there is no drizzle journal tracking for the
 * 0055+ files), an environment can be left with a schema that is one
 * migration behind the code. In that case every crash-arena route that
 * reads or writes host_id fails with a Postgres "column does not exist"
 * error and would otherwise surface as a generic 500 with no hint.
 *
 * These helpers detect that specific failure so routes can return an
 * actionable message instead of a mystery "Server error".
 */

/**
 * Returns true when the thrown error is a Postgres "column does not
 * exist" failure caused by a schema that lags the code.
 *
 * @param err The value caught in a route's try/catch.
 */
export function isMissingCrashArenaColumn(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    /column .* does not exist/i.test(msg) ||
    /column .* of relation/i.test(msg)
  );
}

/** Human-readable hint for the migration the operator needs to run. */
export const CRASH_ARENA_SCHEMA_HINT =
  "Crash Arena database schema is out of date. Please apply migration 0057_crash_arena_host.sql (adds crash_arena_tables.host_id).";
