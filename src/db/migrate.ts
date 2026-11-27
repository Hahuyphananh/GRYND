"use server";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { resolveSslConfig } from "./pool";

/**
 * Migrations run as the OWNER, never as the app's runtime role.
 *
 * Once DATABASE_URL points at the non-owner `app_user`
 * (docs/security-fixes/staging-app-role.sql), DDL from this script would be
 * refused — which is the point of the split. `MIGRATION_DATABASE_URL` is the
 * owner connection string; when it is unset this falls back to the old
 * behaviour (one URL for both), so existing deployments keep working.
 *
 * A dedicated pool is used instead of the shared `db` singleton so the
 * migration process cannot be handed the app pool by accident, and it is
 * always closed — a script that leaves a pool behind never exits.
 */
const main = async () => {
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    "";

  if (!connectionString) {
    console.error(
      "error during migration: neither MIGRATION_DATABASE_URL nor DATABASE_URL is set",
    );
    process.exit(1);
  }

  // `pg` lets `sslmode` in the URL override the explicit `ssl` option, which
  // would defeat the pinned CA (see src/db/pool.ts). TLS is decided solely by
  // resolveSslConfig(), so the parameter is stripped here for the same reason.
  const sanitized = connectionString.replace(
    /([?&])sslmode=[^&]*(&|$)/g,
    (_match, prefix: string, suffix: string) => (suffix === "&" ? prefix : ""),
  );

  const pool = new Pool({
    connectionString: sanitized,
    max: 1,
    ssl: resolveSslConfig(sanitized),
  });

  try {
    await migrate(drizzle(pool), {
      migrationsFolder: "src/db/migrations",
    });

    console.log("migration completed");
  } catch (error) {
    console.log("error during migration: ", error);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
};
main();
