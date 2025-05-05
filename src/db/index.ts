"use server";
import { config } from "dotenv";
config({ path: ".env.local" }); // Load .env first

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!); // Assert it's defined
const db = drizzle(sql);

export { db };
