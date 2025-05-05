"use server";

import { config } from "dotenv";
config({ path: ".env.local" });

import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema"; // ✅ Import the schema

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema }); // ✅ Pass schema here

export { db };
