// qa/rls-audit.mjs
//
// Read-only RLS audit: every table in `public` must have RLS enabled, and every
// policy must be listed so a reviewer can see exactly what a browser key can
// reach. Written for the "move reads to the client" work: the moment the
// publishable key is used from the browser, RLS *is* the authorization layer,
// so this is the check that proves what is actually exposed.
//
// It touches system catalogs only — no application table is read or written.
//
// Usage:
//   node --env-file-if-exists=.env.local qa/rls-audit.mjs
//   npm run verify:rls            (fails on a table with RLS disabled)
//   npm run verify:rls -- --json  (machine-readable)
//
// Exit codes: 0 = all good, 1 = a table is missing RLS, 2 = could not run.

import pg from "pg";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

// Accept either a plain Postgres URL (Hyperdrive/local) or Supabase's.
const raw =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.SUPABASE_DB_URL ||
  "";

if (!raw) {
  console.error("verify:rls — no DATABASE_URL / POSTGRES_URL in the environment.");
  process.exit(2);
}

// `sslmode` in the URL would clobber the explicit ssl option below (see
// src/db/pool.ts for the full story on Supabase's self-signed pooler cert).
const connectionString = raw.replace(
  /([?&])sslmode=[^&]*(&|$)/g,
  (_m, prefix, suffix) => (suffix === "&" ? prefix : ""),
);
const host = (connectionString.match(/@([^:/]+)/) || [])[1] || "";
const isLocal = /localhost|127\.0\.0\.1|::1/.test(host);

const client = new pg.Client({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

let tables;
let policies;
try {
  await client.connect();

  tables = (
    await client.query(`
      select c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             c.relforcerowsecurity as rls_forced,
             count(p.polname) as policies,
             count(p.polname) filter (where p.polcmd in ('r','*')) as read_policies,
             count(p.polname) filter (where p.polroles = '{0}') as policies_for_public_role
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid
       where n.nspname = 'public' and c.relkind = 'r'
       group by 1,2,3
       order by c.relrowsecurity asc, c.relname asc
    `)
  ).rows;

  policies = (
    await client.query(`
      select c.relname as table_name,
             p.polname as policy_name,
             p.polcmd as cmd,
             p.polpermissive as permissive,
             pg_get_expr(p.polqual, p.polrelid) as using_expr,
             pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
       order by c.relname, p.polname
    `)
  ).rows;
} catch (err) {
  console.error(`verify:rls — could not read the catalogs: ${err.message}`);
  await client.end().catch(() => {});
  process.exit(2);
}
await client.end();

const noRls = tables.filter((t) => !t.rls_enabled);
const noPolicy = tables.filter((t) => t.rls_enabled && Number(t.policies) === 0);
const reachable = tables.filter((t) => Number(t.policies_for_public_role) > 0);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        tables: tables.length,
        rlsEnabled: tables.length - noRls.length,
        withoutRls: noRls.map((t) => t.table_name),
        rlsButNoPolicy: noPolicy.map((t) => t.table_name),
        reachableByBrowserKey: reachable.map((t) => t.table_name),
        policies,
      },
      null,
      2,
    ),
  );
} else {
  const cmdName = (cmd) => ({ r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" })[cmd] || cmd;

  console.log("RLS audit — public schema\n");
  console.log(`  tables:                  ${tables.length}`);
  console.log(`  RLS enabled:             ${tables.length - noRls.length}`);
  console.log(`  RLS DISABLED:            ${noRls.length}`);
  console.log(`  RLS on, zero policies:   ${noPolicy.length}   (deny-all: a browser key sees nothing)`);
  console.log(`  reachable via a policy:  ${reachable.length}\n`);

  if (policies.length) {
    console.log("Policies that exist (what a publishable/anon key can actually do):");
    for (const p of policies) {
      const via = p.using_expr || p.check_expr || "(no expression)";
      console.log(`  ${p.table_name}.${p.policy_name}`);
      console.log(
        `      ${cmdName(p.cmd)}${p.permissive ? " (permissive)" : " (RESTRICTIVE)"} — using: ${via}` +
          (p.check_expr && p.check_expr !== p.using_expr ? ` | check: ${p.check_expr}` : ""),
      );
    }
    console.log("");
  }

  if (noRls.length) {
    console.log("FAIL — these tables have RLS DISABLED (a browser key gets full table access):");
    for (const t of noRls) console.log(`  - ${t.table_name}`);
    console.log("");
  } else {
    console.log("PASS — every table in `public` has RLS enabled (default-deny).\n");
  }
}

process.exit(noRls.length ? 1 : 0);
