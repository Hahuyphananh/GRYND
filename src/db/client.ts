import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { getPool } from "./pool";

let dbInstance: NodePgDatabase<typeof schema> | null = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  // Pool creation is deferred until the first query so a missing
  // DATABASE_URL doesn't break the build or unrelated imports.
  dbInstance = drizzle(getPool(), { schema });
  return dbInstance;
}

// Lazy-loaded Proxy: defers pool creation to runtime so next build doesn't fail
// when DATABASE_URL is absent from the build environment.
export const db: NodePgDatabase<typeof schema> = new Proxy(
  {} as NodePgDatabase<typeof schema>,
  {
    get(_target, prop, receiver) {
      return Reflect.get(getDb(), prop, receiver);
    },
  },
);
