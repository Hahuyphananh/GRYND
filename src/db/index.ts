import { config } from "dotenv";
config({ path: ".env.local" });

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

function createDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}

type DbInstance = ReturnType<typeof createDb>;

let dbInstance: DbInstance | null = null;

export function getDb(): DbInstance {
  if (dbInstance) return dbInstance;

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Set it in your runtime environment (for example, Vercel Project Settings > Environment Variables)."
    );
  }

  dbInstance = createDb(connectionString);
  return dbInstance;
}

export const db: DbInstance = new Proxy({} as DbInstance, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
