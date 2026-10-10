/**
 * Guards the Vercel Cron Jobs → Cloudflare Cron Triggers migration (Phase 6).
 *
 * The three scheduled jobs (weekly-reset, retention, daily-reset) are described
 * in THREE places that must agree:
 *
 *   1. `vercel.json` → `crons`            (the scheduler Vercel uses today)
 *   2. `wrangler.jsonc` → `triggers.crons` (the Cloudflare scheduler)
 *   3. `cloudflare-worker.ts` → CRON_ROUTES (the cron-expression → route map
 *      that the Worker's `scheduled` handler dispatches on)
 *
 * If (2) and (3) drift, a job runs but routes nowhere (or the wrong job); if
 * (1) and (2) drift, the two platforms run different schedules during the
 * migration. This test pins all three together, plus the invariant that keeps
 * the jobs safe: the Worker authenticates the loopback call with the
 * CRON_SECRET bearer token, exactly like the Vercel caller does.
 */
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const VERCEL_PATH = "vercel.json";
const WRANGLER_PATH = "wrangler.jsonc";
const WORKER_PATH = "cloudflare-worker.ts";

const read = (p) => readFileSync(p, "utf8");

const vercel = JSON.parse(read(VERCEL_PATH));
const wrangler = read(WRANGLER_PATH);
const worker = read(WORKER_PATH);

/** Pull `"crons": [ ... ]` out of the JSONC wrangler config. */
function wranglerCrons() {
  const match = wrangler.match(/"crons"\s*:\s*\[([^\]]*)\]/);
  assert.ok(match, "wrangler.jsonc must declare a triggers.crons array");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("the Worker entrypoint is the custom cron worker, not the generated one", () => {
  const main = wrangler.match(/"main"\s*:\s*"([^"]+)"/)?.[1];
  assert.equal(
    main,
    "./cloudflare-worker.ts",
    "wrangler.jsonc must point `main` at the custom worker so the scheduled handler exists",
  );
  assert.ok(existsSync(WORKER_PATH), `${WORKER_PATH} must exist`);
});

test("Cloudflare crons match the Vercel crons (same schedules, nothing dropped)", () => {
  const cloudflareCrons = [...wranglerCrons()].sort();
  const vercelCrons = vercel.crons.map((c) => c.schedule).sort();
  assert.deepEqual(
    cloudflareCrons,
    vercelCrons,
    "wrangler.jsonc triggers.crons must list exactly the schedules vercel.json uses",
  );
});

test("every Vercel cron path has a cron→route mapping in the Worker", () => {
  for (const { path, schedule } of vercel.crons) {
    // The mapping in cloudflare-worker.ts is `"<schedule>": "<path>"`.
    const pattern = new RegExp(
      `"${schedule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"${path.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      )}"`,
    );
    assert.match(
      worker,
      pattern,
      `cloudflare-worker.ts must map "${schedule}" → "${path}"`,
    );
  }
});

test("the mapped routes are real job route handlers", () => {
  for (const { path } of vercel.crons) {
    const rel = `src/app${path}/route.ts`;
    assert.ok(
      existsSync(rel),
      `${rel} must exist — cloudflare-worker.ts routes a cron at ${path}`,
    );
  }
});

test("the custom worker re-uses the generated fetch handler and adds scheduled()", () => {
  assert.match(
    worker,
    /import\s+openNextWorker\s+from\s+["']\.\/\.open-next\/worker\.js["']/,
    "the custom worker must import the OpenNext-generated worker",
  );
  assert.match(
    worker,
    /fetch\s*:\s*openNextWorker\.fetch/,
    "the custom worker must forward `fetch` to the generated handler",
  );
  assert.match(
    worker,
    /async\s+scheduled\s*\(/,
    "the custom worker must export a scheduled() handler for Cron Triggers",
  );
});

test("the scheduled handler authenticates with the CRON_SECRET bearer token", () => {
  assert.match(
    worker,
    /env\.CRON_SECRET/,
    "the scheduled handler must read CRON_SECRET from the Worker env",
  );
  assert.match(
    worker,
    /authorization:\s*`Bearer \$\{secret\}`/,
    "the scheduled handler must send the Authorization: Bearer <secret> header the job routes require",
  );
  // The job routes reject unauthenticated calls, so the Worker must not fall
  // through and call them without a secret — it should skip and log instead.
  assert.match(
    worker,
    /if\s*\(!secret\)/,
    "the scheduled handler must bail out (fail-secure) when CRON_SECRET is missing",
  );
});

test("the Vercel cron config is preserved during the migration", () => {
  assert.ok(
    existsSync(VERCEL_PATH),
    "vercel.json must stay in place — the Vercel deploy is still live",
  );
  assert.equal(vercel.crons.length, 3, "vercel.json should still list 3 crons");
});
