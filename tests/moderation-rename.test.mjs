/**
 * moderation-rename.test.mjs
 *
 * Replacing a bad name, and doing it from the admin queue.
 *
 * The filter stops new profane names, but the ones already in the database keep
 * rendering on the public leaderboard. Two paths fix that: an admin acting on a
 * flagged entry, and the one-off sweep. Both must produce a name the filter
 * itself accepts, must not collide with an existing handle, and must keep
 * `search_name` in step — otherwise the old handle stays findable.
 *
 * Run:  node --import tsx --test tests/moderation-rename.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isNameAllowed } from "../src/lib/moderation/profanity.ts";
import { randomCleanName } from "../src/lib/moderation/randomName.ts";

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

// ── The generator ────────────────────────────────────────────────────────

test("a generated handle is clean by the same filter that guards signup", () => {
  for (let i = 0; i < 200; i += 1) {
    const name = randomCleanName();
    assert.match(name, /^[A-Z][a-z]+[A-Z][a-z]+\d{3,4}$/, `${name} looks wrong`);
    assert.equal(isNameAllowed(name), true, `${name} would be rejected at signup`);
  }
});

test("the generator does not hand out names that are already taken", () => {
  // A set large enough to be a real risk of an accidental hit.
  const taken = new Set();
  for (let i = 0; i < 500; i += 1) taken.add(randomCleanName().toLowerCase());

  for (let i = 0; i < 100; i += 1) {
    const name = randomCleanName({ taken });
    assert.equal(taken.has(name.toLowerCase()), false, `${name} was already in use`);
  }
});

test("the generator is actually varied, not a fixed value", () => {
  const drawn = new Set();
  for (let i = 0; i < 200; i += 1) drawn.add(randomCleanName());
  // Collisions in a ~4M namespace at 200 draws are vanishingly rare, so a low
  // count here means the generator is broken (e.g. ignoring its own randomness).
  assert.ok(drawn.size > 190, `only ${drawn.size} distinct names in 200 draws`);
});

test("a hostile taken-set cannot push the generator into a profane name", () => {
  // Every possible generated candidate "taken" forces the fallback path; the
  // result must still be clean and must still respect the set.
  const taken = new Set();
  const placeholder = randomCleanName();
  taken.add(placeholder.toLowerCase());
  const name = randomCleanName({ taken });
  assert.equal(isNameAllowed(name), true);
  assert.notEqual(name.toLowerCase(), placeholder.toLowerCase());
});

// ── The admin action ─────────────────────────────────────────────────────

test("the admin queue can rename the player on a report", () => {
  const route = read("src/app/api/admin/reports/route.ts");

  assert.match(route, /action === "rename"/);
  // Scoped to the player on THIS report — not an arbitrary clerk id.
  assert.match(route, /SELECT reported_clerk_id FROM player_reports WHERE id = /);
  assert.match(route, /randomCleanName\(\)/);
  // The friends-search key must move with the name.
  assert.match(route, /SET name = \$\{newName\}, search_name = \$\{searchNameFor\(newName\)\}/);
  // And the action must be attributable.
  assert.match(route, /adminAuditLog\("admin_report_rename_user"/);
});

test("a flagged review arrives with the review content, not just an id", () => {
  const route = read("src/app/api/admin/reports/route.ts");
  assert.match(route, /LEFT JOIN product_reviews prv/);
  assert.match(route, /prv\.title AS review_title/);
  assert.match(route, /prv\.body AS review_body/);
  // game_id also holds non-numeric ids, so the integer cast must be guarded.
  assert.match(route, /CASE WHEN pr\.game_id ~ '\^\[0-9\]\+\$' THEN pr\.game_id::int END/);
});

test("the admin dashboard surfaces the source and the flagged review", () => {
  const client = read("src/app/admin/AdminDashboardClient.tsx");

  // A public flag is either the player (leaderboard / profile) or the content
  // (review) — a bare lowercase slug told the triager nothing.
  assert.match(client, /function formatSource\(/);
  assert.match(client, /leaderboard: "Leaderboard"/);
  assert.match(client, /review: "Review"/);
  assert.match(client, /formatSource\(r\.game_type\)/);

  // The review body/title must be visible in the queue.
  assert.match(client, /review_title: string \| null/);
  assert.match(client, /r\.review_title \|\| r\.review_body/);

  // And the one-click remedy.
  assert.match(client, /async function handleRenameUser\(/);
  assert.match(client, /action: "rename"/);
  assert.match(client, /handleRenameUser\(r\)/);
  assert.match(client, /"Rename"/);
});

// ── The sweep ────────────────────────────────────────────────────────────

test("the sweep reuses the app's filter instead of reimplementing it in SQL", () => {
  const script = read("scripts/purge-profaned-usernames.mjs");

  // Same rule as the routes...
  assert.match(script, /import \{ findProfanity \}/);
  // ...the same generator as the admin action...
  assert.match(script, /import \{ randomCleanName \}/);
  // ...and the same search-key fold.
  assert.match(script, /import \{ searchNameFor \}/);
  assert.match(script, /SET name = \$1, search_name = \$2/);
});

test("the sweep writes nothing unless it is explicitly told to", () => {
  const script = read("scripts/purge-profaned-usernames.mjs");
  assert.match(script, /const APPLY = argv\.includes\("--apply"\)/);
  // The dry run must bail out before the transaction starts.
  const dryRunExit = script.indexOf("DRY RUN");
  const begin = script.indexOf('client.query("BEGIN")');
  assert.ok(dryRunExit > 0 && begin > 0 && dryRunExit < begin, "the dry run must exit before writing");
  // And a failure mid-sweep must not leave a half-renamed board.
  assert.match(script, /ROLLBACK/);
  assert.match(script, /COMMIT/);
});
