/**
 * moderation-enforcement.test.mjs
 *
 * The moderation pieces are only worth anything if they are actually wired in.
 * A filter module that no signup path calls, or a flag button that never renders,
 * passes its own unit tests and still leaves "Stupidgayzz" at rank 1.
 *
 * These are deliberately source-level assertions: they pin the WIRING, which is
 * exactly the part that rots when a route is refactored. The behaviour of the
 * filter itself is covered in username-moderation.test.mjs, and the review
 * placeholder rule in reviews-moderation.test.mjs.
 *
 * Run:  node --import tsx --test tests/moderation-enforcement.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

// ── The name filter runs on every path a name can enter ───────────────────

test("both signup paths moderate the display name they publish", () => {
  // The Clerk webhook — the normal path for a new account.
  const webhook = read("src/app/api/webhooks/clerk/route.js");
  assert.match(webhook, /moderatedDisplayName\(/);
  assert.match(webhook, /name: displayName/);
  // The welcome email must not reintroduce the raw provider username either.
  assert.equal(
    webhook.includes('username: username || first_name || "Player"'),
    false,
    "the welcome email still uses the unmoderated provider name",
  );

  // The sync fallback — the path taken when the webhook lost the race.
  const sync = read("src/app/api/sync-user/route.ts");
  assert.match(sync, /moderatedDisplayName\(/);
  assert.match(sync, /name: preferredName/);
});

test("the rename endpoint rejects a profane display name", () => {
  const route = read("src/app/api/profile/update/route.js");
  assert.match(route, /import \{ findProfanity \}/);
  assert.match(route, /hasName && findProfanity\(parsed\.data\.name\) !== null/);
  // The rejection must not echo the matched term back to the client.
  assert.equal(
    /error:\s*`[^`]*\$\{[^}]*findProfanity/.test(route),
    false,
    "the error message interpolates the matched term",
  );
});

// ── The flag buttons are rendered on the public surfaces ──────────────────

test("the homepage leaderboard renders a report button on each row", () => {
  const home = read("src/app/PageClient.jsx");
  assert.match(home, /import ReportEntryButton from "\.\.\/components\/reports\/ReportEntryButton"/);
  assert.match(home, /<ReportEntryButton/);
  assert.match(home, /gameType="leaderboard"/);
  // You should not be offered a report button on your own row.
  assert.match(home, /item\.clerk_id !== user\?\.id/);
});

test("the full ranking page renders a report button on each row", () => {
  const classement = read("src/app/classement/PageClient.jsx");
  assert.match(classement, /import ReportEntryButton from "\.\.\/\.\.\/components\/reports\/ReportEntryButton"/);
  assert.match(classement, /<ReportEntryButton/);
  assert.match(classement, /gameType="leaderboard"/);
});

test("the review wall renders a report button on each review card", () => {
  const wall = read("src/components/reviews/ReviewWall.tsx");
  assert.match(wall, /import ReportEntryButton from "\.\.\/reports\/ReportEntryButton"/);
  assert.match(wall, /<ReportEntryButton/);
  // The report needs a target, so the review payload must carry the reviewer.
  assert.match(wall, /clerkId: string \| null/);
  assert.match(wall, /reportedClerkId=\{r\.clerkId\}/);
  assert.match(wall, /gameType="review"/);
});

// ── The shared button reuses the existing report pipeline ─────────────────

test("the flag button files a report through the existing moderation queue", () => {
  const button = read("src/components/reports/ReportEntryButton.tsx");
  assert.match(button, /fetch\("\/api\/reports\/submit"/);
  assert.match(button, /reportedClerkId/);
  assert.match(button, /gameType/);
  // Signed-out visitors cannot report, so they are sent to sign in instead of
  // being shown a modal that would 401 on submit.
  assert.match(button, /sign-in\?redirect_url=/);
  // A report with no target is not a report.
  assert.match(button, /if \(!reportedClerkId\) return null;/);
});

test("the review report target is exposed by the public review query", () => {
  const reviews = read("src/lib/reviews.ts");
  assert.match(reviews, /clerkId: users\.clerkId/);
});
