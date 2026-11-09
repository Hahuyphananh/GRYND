/**
 * solitaire-board-theme-sync.test.mjs
 *
 * CROSS-DEVICE SOLITAIRE THEME — the contract of the account half.
 *
 * The board still renders from the local store; this suite pins the pieces
 * that make a signed-in player's choice follow them to another device:
 *
 *   1. STORAGE — exactly one nullable column, added by an additive migration
 *      and journaled. No new table.
 *   2. THE ROUTE — auth-required for writes, guest reads answer 200 with
 *      signedIn:false, and the key is validated against the catalog in BOTH
 *      directions, so the column can never hold an unrenderable theme.
 *   3. THE SYNC — mounted once for the site (not in the portal), adopts the
 *      account's theme, uploads a local guest choice when the account has none,
 *      pushes every later change once, and never lets a slow response revert a
 *      choice the player just made.
 *   4. LOCAL-FIRST — no API/offline still renders and persists.
 *
 * Run:  node --import tsx --test tests/solitaire-board-theme-sync.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Read a TS file without its comments (full-line and trailing). */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+\/\/[^"'`\n]*$/gm, "");
/** Read a SQL file without its `--` comments. */
const sqlCode = (path) => read(path).replace(/--.*$/gm, "");

const MIGRATION = "src/db/migrations/0245_solitaire_board_theme.sql";
const JOURNAL = "src/db/migrations/meta/_journal.json";
const SCHEMA = "src/db/schema.ts";
const ROUTE = "src/app/api/solitaire/board-theme/route.ts";
const SYNC = "src/hooks/useSolitaireBoardThemeSync.ts";
const STORE = "src/hooks/useSolitaireBoardTheme.ts";
const CHROME = "src/components/SiteChrome.tsx";

// ── 1. Storage ───────────────────────────────────────────────────────────

test("migration: one nullable column, additive, no new table", () => {
  const sql = sqlCode(MIGRATION);
  assert.match(sql, /ALTER TABLE "users"\s+ADD COLUMN IF NOT EXISTS "solitaire_board_theme" varchar\(20\)/);
  assert.equal(/NOT NULL/i.test(sql), false, "NULL must mean 'never chosen'");
  assert.equal(/CREATE TABLE/i.test(sql), false, "a one-key preference does not deserve a table");
  assert.equal(/DROP |DELETE |UPDATE /i.test(sql), false, "the migration must not touch existing data");
  assert.equal(/DEFAULT/i.test(sql), false, "existing accounts must stay NULL, not become 'classic'");
});

test("migration: journaled so it actually runs", () => {
  const journal = JSON.parse(read(JOURNAL));
  const entry = journal.entries.find((e) => e.tag === "0245_solitaire_board_theme");
  assert.ok(entry, "0245 must be in the drizzle journal");
  assert.equal(entry.idx, 226);
  assert.equal(journal.entries.at(-1).tag, "0245_solitaire_board_theme", "it must be the newest entry");
  const idxs = journal.entries.map((e) => e.idx);
  assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b), "journal indices must stay ordered");
});

test("schema: the column is declared and stays nullable", () => {
  const schema = read(SCHEMA).replace(/^\s*\/\/.*$/gm, "");
  assert.match(schema, /solitaireBoardTheme: varchar\("solitaire_board_theme", \{ length: 20 \}\)/);
  assert.equal(
    /solitaireBoardTheme:[^\n]*\.notNull\(\)/.test(schema),
    false,
    "NULL means the player has no saved table yet",
  );
});

// ── 2. The route ─────────────────────────────────────────────────────────

test("route: writes require a signed-in user; guests read without an error", () => {
  const route = code(ROUTE);
  assert.match(route, /import \{ auth \} from "@clerk\/nextjs\/server"/);
  assert.equal((route.match(/await auth\(\)/g) ?? []).length, 2, "both handlers authenticate");
  assert.match(route, /if \(!userId\) \{\s*return NextResponse\.json\(\{ success: true, signedIn: false, theme: null \}\)/);
  assert.match(route, /status: 401/);
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const dynamic = "force-dynamic"/, "a preference must never be cached");
});

test("route: the key is validated in both directions", () => {
  const route = code(ROUTE);
  // Read: an unknown stored key is reported as "no choice", not rendered.
  assert.match(route, /theme: isBoardThemeKey\(row\?\.theme\) \? row\.theme : null/);
  // Write: the guard runs BEFORE the update, and a bad key is a 400.
  const guard = route.indexOf("isBoardThemeKey(incoming)");
  const update = route.indexOf(".set({ solitaireBoardTheme");
  assert.ok(guard > 0 && update > guard, "validate before writing");
  assert.match(route, /if \(!isBoardThemeKey\(incoming\)\)[\s\S]*status: 400/);
  assert.match(route, /\.set\(\{ solitaireBoardTheme: incoming \}\)/);
  // It stores a key, never a colour: no palette in the API layer.
  assert.equal(/#[0-9a-f]{6}/i.test(route), false);
});

test("route: reads and writes only this caller's row", () => {
  const route = code(ROUTE);
  assert.equal((route.match(/eq\(users\.clerkId, userId\)/g) ?? []).length, 2);
  assert.equal(/clerkId:\s*(body|req)/.test(route), false, "the body never chooses the account");
});

// ── 3. The sync hook ─────────────────────────────────────────────────────

test("sync: mounted once, in site chrome only", () => {
  const chrome = code(CHROME);
  assert.match(chrome, /import \{ useSolitaireBoardThemeSync \} from "\.\.\/hooks\/useSolitaireBoardThemeSync"/);
  assert.equal((chrome.match(/useSolitaireBoardThemeSync\(\)/g) ?? []).length, 1);

  // The portal build must not mount it: no Next API there.
  for (const path of [
    "standalone/solitaire-duel/src/App.tsx",
    "src/components/solitaire-duel/SolitaireBoard.tsx",
  ]) {
    assert.equal(code(path).includes("useSolitaireBoardThemeSync"), false, `${path} must stay local-only`);
  }
});

test("sync: adopts the account theme on load", () => {
  const sync = code(SYNC);
  assert.match(sync, /const res = await fetch\(ENDPOINT, \{ cache: "no-store", credentials: "same-origin" \}\)/);
  assert.match(sync, /if \(cancelled \|\| data\?\.signedIn !== true\) return/);
  assert.match(sync, /if \(isBoardThemeKey\(data\.theme\)\) \{[\s\S]*setStoredBoardTheme\(data\.theme\)/);
  // Only a real preset is adopted; the hook never invents a palette.
  assert.equal(/#[0-9a-f]{6}/i.test(sync), false);
});

test("sync: a guest choice is uploaded when the account has none", () => {
  const sync = code(SYNC);
  assert.match(sync, /lastSynced\.current = current;\s*await pushTheme\(current\)/);
  assert.match(sync, /method: "PUT"/);
  assert.match(sync, /body: JSON\.stringify\(\{ theme \}\)/);
});

test("sync: a choice made during the request wins over the server value", () => {
  const sync = code(SYNC);
  assert.match(sync, /const current = getStoredBoardTheme\(\);/);
  assert.match(
    sync,
    /if \(current !== initialTheme\.current \|\| hasPendingBoardThemeSync\(\)\) \{\s*lastSynced\.current = current;\s*await pushTheme\(current\);\s*return;/,
  );
});

test("sync: a newer local choice is never overwritten by an older account value", () => {
  const sync = code(SYNC);
  // A pick made offline / during a failed push leaves a pending marker in the
  // STORE (the hook itself never touches storage). While it is set, the local
  // choice is pushed instead of adopting the server value.
  assert.match(sync, /hasPendingBoardThemeSync\(\)/);
  assert.match(sync, /markBoardThemeSyncPending\(true\)/);
  assert.match(sync, /if \(seq === pushSeq && res\.ok\) markBoardThemeSyncPending\(false\)/);
  assert.equal(sync.includes("localStorage"), false);

  const store = code(STORE);
  assert.match(store, /export function hasPendingBoardThemeSync\(\): boolean/);
  assert.match(store, /export function markBoardThemeSyncPending\(pending: boolean\): void/);
  assert.match(store, /localStorage\.setItem\(BOARD_THEME_PENDING_KEY, "1"\)/);
});

test("sync: every later change is pushed exactly once", () => {
  const sync = code(SYNC);
  assert.match(sync, /if \(!ready\.current \|\| !signedIn\.current\) return;/);
  assert.match(sync, /if \(lastSynced\.current === themeKey\) return;/);
  assert.match(sync, /lastSynced\.current = themeKey;\s*void pushTheme\(themeKey\)/);
  assert.match(sync, /\}, \[themeKey\]\)/, "the push effect follows the store");
});

test("sync and store: local persistence survives every failure mode", () => {
  const sync = code(SYNC);
  // A failed/absent API is silent: no throw, no local reset. (Read with
  // comments: the behaviour is documented in the catch block.)
  assert.match(read(SYNC), /catch \{[\s\S]*Offline/);
  assert.equal(sync.includes("removeItem"), false, "a network failure must never clear the local choice");
  assert.equal(sync.includes("localStorage"), false, "the hook writes through the store, not around it");
  // The store is still the renderer and still caches locally.
  const store = code(STORE);
  assert.match(store, /localStorage\.setItem\(BOARD_THEME_STORAGE_KEY, next\)/);
  assert.match(store, /localStorage\.removeItem\(BOARD_THEME_STORAGE_KEY\)/);
  assert.match(store, /export function getStoredBoardTheme\(\): BoardThemeKey/);
});
