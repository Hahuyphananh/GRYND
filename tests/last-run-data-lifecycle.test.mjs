// tests/last-run-data-lifecycle.test.mjs
//
// LAST RUN's rows are real personal data and real storage. These tests pin the
// three gaps the release audit found: erasing a deleted account's match rows,
// retention of the match record, and the fact that the abandoned-match sweep is
// actually scheduled rather than merely implemented. The last test pins the
// lobby's expired-search state — the queue prunes an entry after 90 s, and a
// panel that kept spinning would strand the player forever.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("account deletion erases the user's LAST RUN match rows (both seats, migration-guarded)", () => {
  const source = read("src/lib/security/deleteUserData.ts");
  assert.ok(source.includes("lastRunMatches"), "the purge must import the LAST RUN table");

  const start = source.indexOf('has("last_run_matches")');
  assert.ok(start > -1, "the delete is skipped when migration 0233 has not been applied");
  const guarded = source.slice(start, source.indexOf("// Reports the user filed", start));
  assert.ok(guarded.includes(".delete(lastRunMatches)"), "the delete runs inside the table guard");
  assert.match(guarded, /player1Id, clerkId/);
  assert.match(guarded, /player2Id, clerkId/);
});

test("retention purges LAST RUN match rows on ended_at, since the table is terminal by construction", () => {
  const source = read("src/app/api/jobs/retention/route.ts");
  assert.ok(source.includes('await purge("last_run_matches", null)'));
  assert.match(source, /statuses: string\[\] \| null/, "the helper accepts a table with no status column");
  assert.ok(
    source.includes('statusList ? `WHERE status IN (${statusList}) AND ${column} < $1`'),
    "a null status list still filters on the timestamp",
  );
});

test("the abandoned-match sweep is scheduled, not merely implemented", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "src/app/api/jobs/last-run-sweep/route.ts")));

  const vercel = JSON.parse(read("vercel.json"));
  const cron = vercel.crons.find((entry) => entry.path === "/api/jobs/last-run-sweep");
  assert.ok(cron, "a scheduler must call the sweep");
  assert.equal(cron.schedule, "17 * * * *");

  const timer = read("deploy/jobs/grynd-job-last-run-sweep.timer");
  assert.match(timer, /OnCalendar=\*-\*-\* \*:17:00 UTC/);
  assert.match(timer, /Unit=grynd-job@last-run-sweep\.service/);

  // The Oracle runner only invokes named jobs; an unlisted name exits 64.
  const runner = read("deploy/jobs/run-job.sh");
  const allowlist = runner.slice(runner.indexOf('case "$JOB" in'), runner.indexOf("esac"));
  assert.ok(allowlist.includes("last-run-sweep"), "the job name must be in the allowlist");

  assert.match(read("deploy/README.md"), /grynd-job-last-run-sweep\.timer/);
});

test("the lobby surfaces an expired queue instead of searching forever", () => {
  const source = read("src/app/games/last-run/LobbyClient.tsx");
  const poll = source.slice(source.indexOf("const poll = async"), source.indexOf("poll();"));
  assert.ok(poll.includes('data.status === "idle"'), "the poll loop must handle the pruned entry");
  assert.ok(poll.includes('setStatus("expired")'));
  assert.ok(source.includes("Search expired"), "the expired panel is user-visible");
});
