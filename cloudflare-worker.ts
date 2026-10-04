// Custom Cloudflare Worker entrypoint (Phase 6 of the Vercel → Cloudflare
// migration: Vercel Cron Jobs → Cloudflare Cron Triggers).
//
// The worker that `@opennextjs/cloudflare` generates only exports a `fetch`
// handler. Cloudflare Cron Triggers invoke a SEPARATE `scheduled` handler, so
// this thin wrapper re-uses the generated `fetch` and adds one — the pattern
// from https://opennext.js.org/cloudflare/howtos/custom-worker
//
// It does nothing on Vercel: `wrangler.jsonc` points `main` here, and only
// wrangler / opennextjs-cloudflare read that file. The Vercel deployment still
// runs `next build` / `next start` and still uses `vercel.json`'s cron config
// unchanged.
//
// `.open-next/worker.js` is produced by `opennextjs-cloudflare build`, so this
// file cannot be type-checked standalone; it is excluded in tsconfig.json the
// same way `open-next.config.ts` is.
//
// @ts-expect-error `.open-next/worker.js` is generated at build time
import openNextWorker from "./.open-next/worker.js";

/**
 * Cron schedule → internal job route.
 *
 * Kept deliberately in lock-step with the two other places that describe the
 * same schedules: `vercel.json` (the scheduler Vercel uses today) and
 * `wrangler.jsonc` → `triggers.crons` (the Cloudflare scheduler). A mismatch
 * between any pair would silently stop a job from running, so
 * tests/cloudflare-cron-workers.test.mjs asserts all three agree.
 *
 * The routes themselves are unchanged and still authenticate with
 * `Authorization: Bearer <CRON_SECRET>` via src/lib/security/cronAuth.ts, so
 * the secret stays the single gate no matter which scheduler fires the job.
 */
const CRON_ROUTES: Record<string, string> = {
  // Mondays 00:00 UTC — weekly leaderboard reset + summary emails.
  "0 0 * * 1": "/api/jobs/weekly-reset",
  // Daily 04:00 UTC — retention sweep of finished matches / stale presence.
  "0 4 * * *": "/api/jobs/retention",
  // Daily 00:00 UTC — reset the responsible-play daily counters.
  "0 0 * * *": "/api/jobs/daily-reset",
};

// Synthetic origin for the in-process loopback request. Only the pathname is
// used by the OpenNext router, and the request never leaves the Worker, so the
// host is arbitrary — but it must be an absolute URL to build a `Request`.
const LOOPBACK_ORIGIN = "https://grynd.internal";

export default {
  fetch: openNextWorker.fetch,

  /**
   * Cloudflare Cron Trigger entrypoint.
   *
   * `event.cron` is the exact schedule string that fired, so we can route to
   * the right job without guessing. We then drive the existing Next.js route
   * handler through the OpenNext `fetch` in-process (no public network hop),
   * passing the same `env`/`ctx` so Hyperdrive, bindings and the Cloudflare
   * request context behave exactly as on a real request.
   */
  async scheduled(
    event: { cron: string },
    env: { CRON_SECRET?: string },
    ctx: unknown,
  ) {
    const path = CRON_ROUTES[event.cron];
    if (!path) {
      console.error(`[cron] No job route mapped for schedule "${event.cron}"`);
      return;
    }

    const secret = env.CRON_SECRET;
    if (!secret) {
      // Fail-secure, mirroring cronAuth.ts: without the secret the route would
      // answer 401 anyway, so skip the round-trip and say why.
      console.error(
        `[cron] CRON_SECRET is not configured; skipping ${path}. ` +
          "Set it with `wrangler secret put CRON_SECRET`.",
      );
      return;
    }

    const request = new Request(`${LOOPBACK_ORIGIN}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
    });

    try {
      const response = await openNextWorker.fetch(request, env, ctx);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(
          `[cron] ${path} failed: ${response.status} ${response.statusText} ${body}`,
        );
        return;
      }
      console.log(`[cron] ${path} ok (${response.status})`);
    } catch (err) {
      console.error(`[cron] ${path} threw:`, (err as Error).message);
    }
  },
};
