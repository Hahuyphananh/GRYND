import { neon } from "@neondatabase/serverless";

let neonSql: ReturnType<typeof neon> | null = null;

function getConnectionString(): string {
  const connectionString =
    process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

  if (!connectionString) {
    throw new Error(
      "Database connection string is missing. Set DATABASE_URL (preferred) or POSTGRES_URL in the runtime environment."
    );
  }

  return connectionString;
}

export function getNeonSql() {
  if (neonSql) return neonSql;
  neonSql = neon(getConnectionString());
  return neonSql;
}

