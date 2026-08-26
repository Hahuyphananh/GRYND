// Shared Drizzle client. Everything imports `db` from either `../db` or
// `../db/client` — both resolve to the same pg-backed instance so there is
// exactly one pool per process.
export { db, getDb } from "./client";
