// tests/migration-journal-guard.test.mjs
//
// GUARD — every migration file must be REGISTERED in drizzle's `_journal.json`.
//
// WHY THIS EXISTS
// ---------------
// `src/db/migrate.ts` runs the drizzle migrator, and the migrator walks ONLY
// `meta/_journal.json`. A `.sql` file that exists on disk but has no journal
// entry is never executed. `schema.ts` and the routes, however, are written
// against the fully-migrated schema, so the first query that touches the
// missing column/table throws at request time and the route answers 500.
//
// That is exactly the outage this guards against: `0206_uno_guest_seat.sql`
// (which adds `uno_games.guest_id`) was committed without a journal entry, so
// every Neon Flush (UNO) start — vs-AI and 1v1 — 500'd with
// `column "guest_id" of relation "uno_games" does not exist`.
//
// WHAT IT CHECKS
// --------------
//   1. every `src/db/migrations/*.sql` is journaled (or explicitly grandfathered),
//   2. the grandfather list never names a file that no longer exists, and never
//      names a file that has since been journaled,
//   3. every journaled tag resolves to a real `.sql` file, with no duplicates,
//   4. `idx` is exactly the entry's array position — the migrator reads the
//      array in order and compares each entry's `when` against a single
//      high-water mark, so a broken chain silently skips migrations.
//
// ADDING A MIGRATION? Add its journal entry too (`drizzle-kit generate` does
// both). If this guard fails, do NOT add the file to `LEGACY_UNJOURNALED` —
// backfill the real journal entry instead.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "src/db/migrations");

const JOURNAL = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
);

const files = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name.replace(/\.sql$/, ""))
  .sort();

const journalTags = JOURNAL.entries.map((entry) => entry.tag);
const journalSet = new Set(journalTags);
const fileSet = new Set(files);

// ── Historical debt ─────────────────────────────────────────────────────────
// Migrations authored before `_journal.json` became the single source of truth
// (three gaps: 0094–0112, 0132–0133, 0151–0161). Their schema is already
// present in the deployed database — applied via `drizzle-kit push` / manually —
// and the migrator's high-water `when` check means they cannot be back-dated
// into the journal without being skipped, so they are pinned here instead.
//
// This list is the ONLY place a migration may exist unjournaled. It must shrink,
// never grow: a new migration belongs in the journal, not in this set.
const LEGACY_UNJOURNALED = new Set([
  "0094_rls_error_logs_policies",
  "0096_enable_realtime_publication",
  "0097_realtime_rls_public_policies",
  "0098_crash_poker",
  "0099_crash_poker_allin_blinds",
  "0100_crash_poker_side_pot_return",
  "0101_crash_arena_private_and_next_round",
  "0102_crash_arena_private_join_code",
  "0103_crash_arena_ai_nickname",
  "0104_match_lifecycle",
  "0105_match_lifecycle_events",
  "0106_availability_alerts",
  "0107_quick_queue_requests",
  "0108_quick_queue_assignments",
  "0109_quick_queue_assignment_events",
  "0110_platform_quick_queue_readiness",
  "0111_quick_queue_assignment_destination",
  "0112_quick_queue_mines_preferences",
  "0132_user_quests",
  "0133_battlepass",
  "0151_result_progression",
  "0152_game_plays",
  "0153_drop_banners",
  "0154_drop_avatar_frame",
  "0155_add_subscription_tiers",
  "0161_crash_arena_unique_active_seat",
]);

test("every migration file is registered in the drizzle journal", () => {
  const unregistered = files.filter(
    (file) => !journalSet.has(file) && !LEGACY_UNJOURNALED.has(file),
  );

  assert.deepEqual(
    unregistered,
    [],
    `unregistered migration(s): ${unregistered.join(", ")} — ` +
      "db:migrate skips any .sql without a _journal.json entry, which makes the " +
      "columns/tables it adds 500 at request time. Register it instead of shipping.",
  );
});

test("the grandfather list never names a missing or journaled file", () => {
  const missing = [...LEGACY_UNJOURNALED].filter((tag) => !fileSet.has(tag));
  assert.deepEqual(
    missing,
    [],
    `LEGACY_UNJOURNALED names files that do not exist: ${missing.join(", ")} — prune the list.`,
  );

  const nowJournaled = [...LEGACY_UNJOURNALED].filter((tag) => journalSet.has(tag));
  assert.deepEqual(
    nowJournaled,
    [],
    `these tags are journaled and must be removed from LEGACY_UNJOURNALED: ${nowJournaled.join(", ")}`,
  );
});

test("every journaled tag resolves to a real migration file", () => {
  const dangling = journalTags.filter((tag) => !fileSet.has(tag));
  assert.deepEqual(
    dangling,
    [],
    `journal entries without a .sql file: ${dangling.join(", ")} — the migrator throws on these.`,
  );

  assert.equal(
    new Set(journalTags).size,
    journalTags.length,
    "duplicate tag in _journal.json",
  );
});

test("the journal is one ordered chain (idx === array position)", () => {
  JOURNAL.entries.forEach((entry, index) => {
    assert.equal(
      entry.idx,
      index,
      `entry ${index} (${entry.tag}) has idx ${entry.idx}; drizzle reads the array in order`,
    );
  });
});
