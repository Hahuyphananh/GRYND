// scripts/db-migrate-check.mjs
//
// Read-only check: are migrations 0126 (pack bulk discount) and 0127
// (daily_loss_limit column) actually applied in the database?
//   * 0126 → token_packages should show medium 20,000+2,000 / large
//            40,000+8,000 / mega 90,000+30,000.
//   * 0127 → users.daily_loss_limit column should exist.
//
// Usage: node scripts/db-migrate-check.mjs

import pg from "pg";
import "dotenv/config";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error("No DATABASE_URL / POSTGRES_URL in env");
  process.exit(1);
}

// Supabase pooler: strip sslmode (it would clobber the explicit ssl option)
// and force SSL for non-local hosts — same handling as src/db/pool.ts.
const sanitized = url.replace(/([?&])sslmode=[^&]*(&|$)/g, (_m, p, s) => (s === "&" ? p : ""));
const host = new URL(sanitized).hostname || "";
const isLocal = /localhost|127\.0\.0\.1|::1/.test(host);
const client = new pg.Client({
  connectionString: sanitized,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

try {
  await client.connect();
  const packages = await client.query(
    `SELECT key, token_amount, bonus_tokens, sort_order
       FROM token_packages
      ORDER BY sort_order`
  );
  console.log("=== token_packages (is 0126 applied?) ===");
  for (const r of packages.rows) {
    console.log(
      `  ${r.key.padEnd(8)} ${String(r.token_amount).padStart(6)} + ${String(r.bonus_tokens).padStart(6)} bonus`
    );
  }

  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'daily_loss_limit'`
  );
  console.log("=== users.daily_loss_limit (is 0127 applied?) ===");
  console.log(cols.rows.length > 0 ? "  EXISTS ✓" : "  MISSING ✗");

  const plan = await client.query(
    `SELECT key, monthly_tokens, price_cents FROM token_subscription_plans`
  );
  console.log("=== token_subscription_plans ===");
  for (const r of plan.rows) {
    console.log(`  ${r.key.padEnd(12)} ${r.monthly_tokens} tokens/mo, $${(Number(r.price_cents) / 100).toFixed(2)}`);
  }
} catch (err) {
  console.error("Check failed:", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
