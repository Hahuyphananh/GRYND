// tests/battleship-ai.test.mjs
//
// PHASE 6 — Battlefield practice vs the built-in bot.
//
// Two kinds of check live here:
//   • BEHAVIOUR of the pure chooser (which cells each tier picks, that it never
//     repeats a shot, that hard stays inside its evaluation budget);
//   • CONTRACTS over the server source, because the properties that matter most
//     — "the bot locks before you do", "the bot cannot see your fleet", "practice
//     can never touch ranked" — are ordering/architecture facts, not values a
//     unit call can return.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  AI_MAX_DENSITY_EVALS,
  chooseAiAttack,
} from "../src/lib/battleship/ai.ts";
import { FLEET_CELL_COUNT, SHIP_KEYS } from "../src/lib/battleship/constants.ts";
import { generateRandomFleet } from "../src/lib/battleship/fleet.ts";
import { validateFleet } from "../src/lib/battleship/rules.ts";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const AI = "src/lib/battleship/ai.ts";
const STORE = "src/lib/battleship/serverStore.ts";
const CREATE_AI = "src/app/api/battleship/create-ai/route.ts";
const PRACTICE = [
  "src/app/api/battleship/practice/[matchId]/route.ts",
  "src/app/api/battleship/practice/[matchId]/fleet/route.ts",
  "src/app/api/battleship/practice/[matchId]/attack/route.ts",
];

const neverSlip = () => 1;
const firstIndex = () => 0;

/** Build a resolved attack log from [coordinate, result, ship?] rows. */
const log = (rows) =>
  rows.map(([coordinate, result, ship = null], index) => ({
    round: index + 1,
    seat: "player2",
    coordinate,
    result,
    ship,
  }));

// ── The AI fleet ──────────────────────────────────────────────────────────

test("the bot's fleet is dealt by the engine: five ships, 17 cells, never visible", () => {
  for (let run = 0; run < 25; run += 1) {
    const fleet = generateRandomFleet();
    const verdict = validateFleet(fleet);
    assert.equal(verdict.ok, true, "the engine's own fleet must validate");
    assert.equal(fleet.ships.length, 5);
    const cells = new Set();
    for (const placement of fleet.ships) {
      const length = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 }[
        placement.ship
      ];
      const step = placement.orientation === "horizontal" ? [1, 0] : [0, 1];
      for (let i = 0; i < length; i += 1) {
        cells.add(`${placement.x + step[0] * i},${placement.y + step[1] * i}`);
      }
    }
    assert.equal(cells.size, FLEET_CELL_COUNT);
  }

  const store = code(STORE);
  assert.match(store, /generateRandomFleet\(random\)/, "creation deals with the engine dealer");
  assert.match(store, /seat: "player2"[\s\S]{0,80}placement: serializeFleet\(fleet\)/);
  // The projection has no opponent-fleet field at all.
  const view = code("src/lib/battleship/view.ts");
  assert.doesNotMatch(view, /opponent[\s\S]{0,40}fleet/);
});

// ── The chooser's signature: public information only ──────────────────────

test("the chooser receives attack history, never a fleet", () => {
  const source = code(AI);
  for (const forbidden of [
    "battleshipFleets",
    "serverStore",
    "deserializeFleet",
    "generateRandomFleet",
    "Fleet",
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden}\\b`), `${forbidden} must not appear`);
  }
  assert.match(source, /attacks: readonly AttackRecord\[\]/);
  assert.doesNotMatch(
    source,
    /fleet|shipPositions|placement/i,
    "nothing in the bot may read ship positions",
  );
  // The store hands it exactly the bot's own resolved log.
  assert.match(
    code(STORE),
    /chooseAiAttack\(\{[\s\S]{0,160}attacks: resolvedRecords\(attacks, "player2"\)/,
  );
});

// ── EASY ──────────────────────────────────────────────────────────────────

test("easy fires uniformly at random and never twice at the same cell", () => {
  const fired = new Set();
  for (let round = 0; round < 100; round += 1) {
    const attacks = log([...fired].map((coordinate) => [coordinate, "miss"]));
    const pick = chooseAiAttack({
      difficulty: "easy",
      attacks,
      randomInt: (max) => (round * 7) % max,
      random: neverSlip,
    });
    assert.ok(pick, "the board still has cells");
    assert.equal(fired.has(pick), false, `${pick} was already fired at`);
    fired.add(pick);
  }
  assert.equal(fired.size, 100);

  // Easy ignores hits entirely — a hit in the log must not bias it.
  const withHit = chooseAiAttack({
    difficulty: "easy",
    attacks: log([["E5", "hit"]]),
    randomInt: firstIndex,
    random: neverSlip,
  });
  assert.equal(withHit, "A1");
});

// ── NORMAL ────────────────────────────────────────────────────────────────

test("normal hunts adjacent cells around an unresolved hit", () => {
  const pick = chooseAiAttack({
    difficulty: "normal",
    attacks: log([["E5", "hit"]]),
    randomInt: firstIndex,
    random: neverSlip,
  });
  assert.ok(["D5", "F5", "E4", "E6"].includes(pick), `${pick} must touch the hit`);
  assert.equal(pick === "E5", false);
});

test("normal abandons a confirmed sunk ship and sweeps a checkerboard", () => {
  const pick = chooseAiAttack({
    difficulty: "normal",
    // The hit's ship is named, so it is sunk: no target remains.
    attacks: log([["E5", "sunk", "cruiser"]]),
    randomInt: firstIndex,
    random: neverSlip,
  });
  // Checkerboard cells have an even x+y; the first is A1 (0+0).
  assert.equal(pick, "A1");
});

test("normal slips sometimes (shared mistake rate keeps it beatable)", () => {
  const adjacent = new Set(["D5", "F5", "E4", "E6"]);
  const slip = chooseAiAttack({
    difficulty: "normal",
    attacks: log([["E5", "hit"]]),
    randomInt: firstIndex,
    random: () => 0, // always inside the slip window
  });
  assert.equal(adjacent.has(slip), false, `${slip} is the random slip, not the target shot`);
});

// ── HARD ──────────────────────────────────────────────────────────────────

test("hard never fires at a known miss or an already-fired cell", () => {
  const attacks = log([
    ["A1", "miss"],
    ["A2", "miss"],
    ["A3", "miss"],
    ["E5", "hit"],
    ["E6", "hit"],
  ]);
  for (let round = 0; round < 40; round += 1) {
    const pick = chooseAiAttack({
      difficulty: "hard",
      attacks,
      randomInt: () => round % 10,
      random: neverSlip,
    });
    assert.ok(pick, "a legal cell exists");
    assert.equal(["A1", "A2", "A3", "E5", "E6"].includes(pick), false);
  }
});

test("hard is deterministic for the same inputs and finishes inside its budget", () => {
  const attacks = log([
    ["C3", "hit"],
    ["D3", "miss"],
    ["B3", "miss"],
  ]);
  const a = chooseAiAttack({ difficulty: "hard", attacks, randomInt: firstIndex, random: neverSlip });
  const b = chooseAiAttack({ difficulty: "hard", attacks, randomInt: firstIndex, random: neverSlip });
  assert.equal(a, b);

  assert.ok(AI_MAX_DENSITY_EVALS <= 20000, "the density cap is bounded");
  const source = code(AI);
  assert.match(source, /evaluations > AI_MAX_DENSITY_EVALS/);
  assert.match(source, /break;/);

  // A near-full board is the worst case and must stay fast.
  const allButOne = [];
  for (const column of "ABCDEFGHIJ") {
    for (let row = 1; row <= 10; row += 1) {
      const cell = `${column}${row}`;
      if (cell !== "J10") allButOne.push([cell, "miss"]);
    }
  }
  const started = Date.now();
  const pick = chooseAiAttack({
    difficulty: "hard",
    attacks: log(allButOne),
    randomInt: firstIndex,
    random: neverSlip,
  });
  assert.equal(pick, "J10");
  assert.ok(Date.now() - started < 500, "the bounded enumeration is milliseconds, not seconds");
});

test("every tier stops when the board is exhausted", () => {
  const exhausted = [];
  for (const column of "ABCDEFGHIJ") {
    for (let row = 1; row <= 10; row += 1) exhausted.push([`${column}${row}`, "miss"]);
  }
  for (const difficulty of ["easy", "normal", "hard"]) {
    assert.equal(
      chooseAiAttack({ difficulty, attacks: log(exhausted), randomInt: firstIndex }),
      null,
    );
  }
});

test("no tier ever fires at the same coordinate twice", () => {
  for (const difficulty of ["easy", "normal", "hard"]) {
    const fired = new Set();
    for (let round = 0; round < 100; round += 1) {
      const attacks = log([...fired].map((coordinate) => [coordinate, "miss"]));
      const pick = chooseAiAttack({
        difficulty,
        attacks,
        randomInt: (max) => (round * 13) % max,
      });
      assert.ok(pick);
      assert.equal(fired.has(pick), false, `${difficulty} repeated ${pick}`);
      fired.add(pick);
    }
  }
});

// ── Simultaneous combat: the bot commits BEFORE the human ─────────────────

test("the bot locks its shot before the human can submit one", () => {
  const store = code(STORE);

  // Combat start: the human's fleet confirmation is what opens the round, and
  // the bot's shot is committed inside that same transaction.
  const confirm = store.slice(store.indexOf("export async function confirmFleet"));
  const commitAt = confirm.indexOf("await commitAiAttackTx(tx, updated)");
  const returnAt = confirm.indexOf("return { dto: await buildDto(updated, seat, tx), confirmed: false }");
  assert.ok(commitAt > 0 && commitAt < returnAt, "the bot locks before the confirm returns");

  // Every resolution pre-commits the NEXT round, so the choice precedes the
  // human's submission for that round.
  const resolve = store.slice(store.indexOf("async function resolveLockedRoundTx"));
  assert.match(resolve, /if \(row\.isAi && !finished\) \{\s*await commitAiAttackTx\(tx, updated\);/);

  // And a lock that is somehow missing is filled before the round can resolve.
  const submit = store.slice(store.indexOf("export async function submitAttack"));
  const ensureAt = submit.indexOf("await ensureAiAttackTx(tx, row, row.round)");
  const lockedAt = submit.indexOf("roundLocked(merged, row.round)");
  assert.ok(ensureAt > 0 && ensureAt < lockedAt, "the bot is locked before the round check");
});

test("practice rounds resolve through the same simultaneous engine path as ranked", () => {
  const store = code(STORE);
  assert.match(store, /resolveRound\(state, submissions\)/);
  const practiceAttack = code(PRACTICE[2]);
  assert.match(practiceAttack, /submitAttack\(\{ userId, matchId, coordinate: body\?\.coordinate \}\)/);
  // The bot's lock is an ordinary result-null row: the human snapshot sees only
  // "opponent locked", never the coordinate.
  assert.match(store, /values\(\{ matchId: row\.id, round, seat: "player2", coordinate \}\)/);
  assert.match(store, /opponentLocked:/);
});

// ── Practice creation, identity and isolation ─────────────────────────────

test("practice creation is gated by the shared practice gate and validates the tier", () => {
  const route = code(CREATE_AI);
  assert.match(route, /requirePracticePlayer\(\{ create: true \}\)/);
  assert.match(route, /isAiDifficulty\(body\.difficulty\)/);
  assert.match(route, /DEFAULT_AI_DIFFICULTY/);
  assert.match(route, /practice: true/);
  for (const file of PRACTICE) {
    assert.match(code(file), /requirePracticePlayer\(\)/, `${file} must accept a guest`);
    assert.match(code(file), /isAi !== true/, `${file} must refuse a ranked match`);
  }
  // Ranked surfaces never weaken to the practice gate.
  for (const file of [
    "src/app/api/battleship/create-or-join/route.ts",
    "src/app/api/battleship/match/[matchId]/route.ts",
    "src/app/api/battleship/match/[matchId]/fleet/route.ts",
    "src/app/api/battleship/match/[matchId]/attack/route.ts",
  ]) {
    assert.doesNotMatch(code(file), /requirePracticePlayer/, `${file} must stay age-gated`);
  }
});

test("practice creation stamps the lifecycle's queue time from its own clock", () => {
  // The canonical lifecycle rejects a negative queue wait, so a `queued_at`
  // taken AFTER the `forming`/`ready`/`started` instants made the shared helper
  // throw "Queue lifecycle timestamps are out of order" and rolled the whole
  // practice match back as a 500. The queue time must therefore be the same
  // instant the transitions use.
  const store = code(STORE);
  const create = store.slice(store.indexOf("export async function createAiMatch"));
  const queuedAt = create.indexOf("queuedAt: now");
  const forming = create.indexOf('to: "forming"');
  assert.ok(queuedAt > 0, "createMatchLifecycle must be given queuedAt: now");
  assert.ok(forming > queuedAt, "queuedAt must be stamped before the transitions");
});

test("practice can never enter ranked: no Elo, trophies, payouts or matchmaking", () => {
  const store = code(STORE);
  assert.match(store, /mode: "practice"/);
  assert.match(store, /isAi: true/);
  // Matchmaking only claims rows with an empty second seat; an AI row has one.
  assert.match(
    store,
    /isNull\(battleshipMatches\.player2Id\)/,
    "an AI row can never be joined or listed",
  );
  for (const file of [AI, CREATE_AI, ...PRACTICE]) {
    assert.doesNotMatch(
      code(file),
      /applyRatingResult|applyTrophyResult|escrowMatchWagers|settlePayout|markDailyRewardWin/,
      `${file} must not reach a ranked settlement`,
    );
  }
  // The STORE does settle ranked PvP (Phase 7 registers the game in RATED_GAMES),
  // but only through the shared writers and only past the practice guard.
  assert.match(store, /if \(row\.isAi \|\| !row\.player2Id\) return;/, "practice never settles");
  assert.doesNotMatch(store, /escrowMatchWagers|settlePayout|markDailyRewardWin/);
  // No fake human account: the bot is a sentinel id in the seat column only.
  assert.match(code("src/lib/battleship/constants.ts"), /BATTLESHIP_AI_PLAYER_ID = "battleship_ai_bot"/);
  assert.doesNotMatch(code(STORE), /insert\(users\)/);
});

test("a reconnect restores practice from the authoritative snapshot, not a reset", () => {
  const page = code("src/app/casino/battleship/PageClient.tsx");
  assert.match(page, /api\/battleship\/practice\/\$\{matchId\}/);
  assert.match(code(PRACTICE[0]), /fetchMatch\(\{ userId, matchId \}\)/);
  // The snapshot route publishes lazy settlements but never mutates state itself.
  assert.doesNotMatch(code(PRACTICE[0]), /submitAttack|confirmFleet|createAiMatch/);
});

// ── UI contract ───────────────────────────────────────────────────────────

test("the lobby offers both modes with the shared picker and an AI match screen", () => {
  const page = code("src/app/casino/battleship/PageClient.tsx");
  // Both modes come from the SHARED casino lobby, exactly like every other 1v1
  // game — the online action is `onPlay`, practice is the violet `vsAi` action.
  assert.match(page, /from "\.\.\/\.\.\/\.\.\/components\/lobby\/PvpLobby"/);
  assert.match(page, /onPlay=\{\(\) => void joinQueue\(\)\}/);
  assert.match(page, /playLabel="Find a Match"/);
  assert.match(page, /vsAi=\{\{/);
  assert.match(page, /onClick: \(\) => void startPractice\(\)/);
  // The tier picker lives in the shared lobby's `children` slot, and the open
  // lobby list is wired to the game's own endpoints.
  assert.match(page, /<AiDifficultyPicker\s+gameKey="battleship"/);
  assert.match(page, /\/api\/battleship\/create-ai/);
  assert.match(page, /\/api\/battleship\/available/);
  assert.match(page, /onRestart=\{\(\) => void startPractice\(\)\}/);

  const preview = code("src/components/games/battleship/BattlePreview.tsx");
  assert.match(preview, /data-testid="ai-difficulty"/);
  assert.match(preview, /data-testid="ai-thinking"/);
  assert.match(preview, /data-testid="practice-restart"/);
  assert.match(preview, /data-testid="practice-lobby"/);
  assert.match(preview, /GRYND AI/);
  // The enemy board still gets no `ships` prop.
  assert.doesNotMatch(preview, /<BoardGrid[^>]*ships=\{view\.(you|opponent)/);
});

test("the difficulty preference uses the shared per-game storage key", () => {
  const page = code("src/app/casino/battleship/PageClient.tsx");
  assert.match(page, /readStoredAiDifficulty\("battleship"\)/);
  assert.match(page, /gameKey="battleship"/);
  const picker = code("src/components/lobby/AiDifficultyPicker.tsx");
  assert.match(picker, /storeAiDifficulty\(gameKey, next\)/);
});

test("the shared fleet table still has five ships / seventeen cells", () => {
  assert.equal(SHIP_KEYS.length, 5);
  assert.equal(FLEET_CELL_COUNT, 17);
});
