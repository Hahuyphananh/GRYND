// qa/icon-select-check.mjs
// Verifies the server-side equip path (mirrors src/lib/icons.ts selectIcon)
// against the live DB in a ROLLED-BACK transaction — nothing persists.
import "dotenv/config";

const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const cs = raw.replace(/([?&])sslmode=[^&]*(&|$)/g, (_m, p, s) => (s === "&" ? p : ""));
const host = new URL(cs).hostname || "";
const { default: pg } = await import("pg");
const pool = new pg.Pool({
  connectionString: cs,
  ssl: /localhost|127\.0\.0\.1|::1/.test(host) ? undefined : { rejectUnauthorized: false },
});

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      "SELECT id, selected_icon FROM users WHERE clerk_id IS NOT NULL ORDER BY id LIMIT 1"
    );
    const uid = u.rows[0].id;
    const before = u.rows[0].selected_icon;

    // Step 1: catalog check (getIconByKey)
    const cat = await client.query(
      "SELECT key FROM icons WHERE key = $1 AND enabled = TRUE LIMIT 1",
      ["gryndicon1"]
    );
    // Step 2: ownership check (user_icons)
    const owned = await client.query(
      "SELECT id FROM user_icons WHERE user_id = $1 AND icon_key = $2 LIMIT 1",
      [uid, "gryndicon1"]
    );
    console.log("catalog row:", cat.rows.length ? cat.rows[0].key : "MISSING", "| owned:", owned.rows.length ? "YES" : "NO");

    // Step 3: write users.selected_icon (selectIcon UPDATE)
    await client.query("UPDATE users SET selected_icon = $1 WHERE id = $2", ["gryndicon1", uid]);
    const after = await client.query("SELECT selected_icon FROM users WHERE id = $1", [uid]);
    console.log("before:", before, "-> after update (read-back):", after.rows[0].selected_icon);
    console.log(after.rows[0].selected_icon === "gryndicon1" ? "PASS: write path works" : "FAIL: write path broken");
  } finally {
    await client.query("ROLLBACK"); // nothing persists
    client.release();
  }
} finally {
  await pool.end();
}