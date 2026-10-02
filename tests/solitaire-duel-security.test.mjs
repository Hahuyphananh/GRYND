/**
 * solitaire-duel-security.test.mjs
 *
 * SOURCE-LEVEL AUDITS of the trust boundary.
 *
 * The behavioural tests (store/rules/deck) prove what the code DOES. These
 * prove what the code CANNOT DO, which is the part a future edit is most likely
 * to break silently:
 *
 *   1. the deal is never generated with `Math.random()` — a match must always be
 *      reproducible from its seed
 *   2. cryptographic seed material is confined to one server-only file, and the
 *      client-safe modules import no server runtime at all
 *   3. the store reads no client-supplied winner / result / progress /
 *      completion / rating / trophy field
 *   4. the server seed is only ever served once the match is terminal
 *   5. the board a client receives is a PROJECTION, never a spread of the row
 *
 * Run:  npm run test:solitaire-duel
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const GAME_DIR = "src/lib/solitaire-duel";
const files = {
  constants: `${GAME_DIR}/constants.ts`,
  types: `${GAME_DIR}/types.ts`,
  deck: `${GAME_DIR}/deck.ts`,
  rules: `${GAME_DIR}/rules.ts`,
  seeds: `${GAME_DIR}/seeds.js`,
  ui: `${GAME_DIR}/ui.ts`,
  store: `${GAME_DIR}/serverStore.ts`,
  // The client's own modules. They are held to the same boundary as the engine
  // they build on: `interactions.ts` reuses the rules, and `rooms.ts` is the
  // Socket.IO vocabulary, which must stay import-free so a client component can
  // name a room without pulling the server half of the game into the bundle.
  interactions: `${GAME_DIR}/interactions.ts`,
  rooms: `${GAME_DIR}/rooms.ts`,
};

const read = (path) => fs.readFileSync(path, "utf8");

/** Source with comments removed, so prose about a rule can't trip an assertion. */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** SQL with `--` comments removed (the migration explains what it omits). */
const sqlCode = (path) => read(path).replace(/--.*$/gm, "");

/** The modules a client component may import. */
const CLIENT_SAFE = [
  files.constants,
  files.types,
  files.deck,
  files.rules,
  files.ui,
  files.interactions,
  files.rooms,
];

// ── 1. Determinism: no uncontrolled randomness in the deal path ───────────

test("randomness: no game module uses Math.random()", () => {
  for (const path of Object.values(files)) {
    assert.doesNotMatch(
      code(path),
      /Math\.random/,
      `${path} must not use Math.random() — a deal must be reproducible from its seed`,
    );
  }
});

test("randomness: the deal is derived from the platform's deterministic PRNG", () => {
  const deck = code(files.deck);
  assert.match(deck, /import\s*\{\s*mulberry32\s*\}\s*from\s*"\.\.\/physics2d\/deterministic"/);
  assert.match(deck, /mulberry32\(seed\)/);
  // Fisher–Yates: every position swapped exactly once, from the end.
  assert.match(deck, /for\s*\(let i = deck\.length - 1; i > 0; i -= 1\)/);
  assert.match(deck, /Math\.floor\(rand\(\) \* \(i \+ 1\)\)/);
});

test("randomness: the deal seed is a SHA-256 digest, not a counter or a clock", () => {
  const seeds = code(files.seeds);
  assert.match(seeds, /createHash\("sha256"\)/);
  assert.match(seeds, /randomBytes/);
  // The variant version is part of the digest, so a ruleset change cannot
  // silently reinterpret an existing match's stored deal.
  assert.match(seeds, /variant:\$\{variantVersion\}/);
  assert.doesNotMatch(seeds, /Date\.now|Math\.random/);
});

// ── 2. The server-only boundary ───────────────────────────────────────────

test("boundary: the client model cannot be handed a server-only module", () => {
  // interactions.ts builds candidate moves from a client view and reuses the
  // engine to check them — it must never reach for a deal, a seed or the store.
  const interactions = code(files.interactions);
  assert.doesNotMatch(interactions, /dealFromSeed|initialStateFromDeal|randomHex|deriveDealSeed/);
  assert.match(interactions, /import[\s\S]*from "\.\/rules"/);
  // rooms.ts restates the event vocabulary and must import nothing at all.
  assert.equal(
    [...code(files.rooms).matchAll(/^\s*import\s/gm)].length,
    0,
    "rooms.ts must be import-free so any client can use it",
  );
});

test("boundary: only seeds.js imports the crypto module", () => {
  const cryptoImporters = Object.values(files).filter((path) =>
    /from\s+"(node:)?crypto"/.test(read(path)),
  );
  assert.deepEqual(cryptoImporters, [files.seeds]);
  assert.match(read(files.seeds), /SERVER-ONLY/);
});

test("boundary: no client-safe module reaches for a server runtime", () => {
  const forbidden = [
    /from\s+"(node:)?crypto"/,
    /from\s+"\.\.\/\.\.\/db\//,
    /\brequire\(/,
    /from\s+"(node:)?fs"/,
    /from\s+"(node:)?http"/,
    /from\s+"\.\/seeds/,
    /from\s+"\.\/serverStore/,
  ];
  for (const path of CLIENT_SAFE) {
    const source = code(path);
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        source,
        pattern,
        `${path} must stay importable from a client component (${pattern})`,
      );
    }
  }
});

test("boundary: the client-safe engine imports only pure helpers", () => {
  const allowed = [
    /from\s+"\.\/constants"/,
    /from\s+"\.\/types"/,
    /from\s+"\.\/deck"/,
    /from\s+"\.\/rules"/,
    /from\s+"\.\.\/physics2d\/deterministic"/,
  ];
  for (const path of CLIENT_SAFE) {
    const specifiers = [...code(path).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      const ok = allowed.some((pattern) => pattern.test(`from "${specifier}"`));
      assert.equal(ok, true, `${path} imports ${specifier}, which is not client-safe`);
    }
  }
});

// ── 3. No client-supplied result, progress or reward ─────────────────────

test("trust: the store reads no client-authored field but the move", () => {
  const store = code(files.store);

  // The move payload (and its cursor) are the ONLY things taken from a caller.
  assert.match(store, /move: unknown/);
  assert.match(store, /expectedPly\?: unknown/);

  // None of these may ever be read from a request.
  for (const field of [
    "body.winner",
    "body.result",
    "body.progress",
    "body.completed",
    "body.score",
    "body.elo",
    "body.rating",
    "body.trophy",
    "body.status",
    "body.board",
    "body.foundations",
    "body.tableau",
  ]) {
    assert.doesNotMatch(store, new RegExp(field.replace(".", "\\.")), `${field} must never be read`);
  }

  // The winner and the result are only ever written from the derived outcome.
  assert.match(store, /outcome\.result === RESULT\.DRAW \? null : userIdForSeat\(seats, outcome\.result\)/);
  assert.match(store, /result: outcome\.result/);
  assert.match(store, /resolutionReason: outcome\.resolution/);
});

test("trust: hits and results are only ever derived, never accepted", () => {
  const store = code(files.store);

  // Every terminal path funnels through ONE finalisation seam, and that seam is
  // the only caller of the ONE settlement function.
  assert.equal((store.match(/async function finalizeMatch\(/g) ?? []).length, 1);
  assert.equal((store.match(/async function settleSolitaireDuelMatch\(/g) ?? []).length, 1);
  assert.equal((store.match(/await settleSolitaireDuelMatch\(/g) ?? []).length, 1);
  assert.ok(
    (store.match(/await finalizeMatch\(/g) ?? []).length >= 3,
    "completion, inactivity and a forfeit must all settle through the seam",
  );

  // The shared writers are called with the canonical key, and NO other key
  // exists anywhere in the game — a wrong key would silently rate another game.
  assert.equal((store.match(/applyRatingResult\(\{/g) ?? []).length, 2);
  assert.equal((store.match(/applyTrophyResult\(\{/g) ?? []).length, 2);
  const keys = [...store.matchAll(/gameKey:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length >= 4, "the settlement calls must name the key literally");
  assert.deepEqual([...new Set(keys)], ["solitaire-duel"]);

  // No second rating or trophy implementation exists in the game.
  assert.doesNotMatch(store, /calculateElo|computeElo|ratingDelta|newRating/);
});

test("trust: the client cannot move before GO or after going idle", () => {
  const store = code(files.store);
  assert.match(store, /nowMs < goAtMs/, "the GO instant must be enforced server-side");
  assert.match(store, /if \(isInactivityDue\(match, nowMs\)\)/, "inactivity must be enforced server-side");
  assert.match(store, /err\("The race has not started", 409\)/);
  assert.match(store, /err\("A seat forfeited for inactivity", 409\)/);
});

test("trust: inactivity is enforced server-side, per seat, with fixed thresholds", () => {
  const constants = code(files.constants);
  const store = code(files.store);
  // The two thresholds live in the one source of truth.
  assert.match(constants, /INACTIVITY_ALARM_MS = 900_000/);
  assert.match(constants, /INACTIVITY_FORFEIT_MS = 1_200_000/);
  // The match is untimed: no live match gets a deadline written.
  assert.doesNotMatch(store, /deadlineAt: new Date/, "no deadline may be armed");
  // The forfeit is resolved from the row, on read and on the move path.
  assert.match(store, /export async function resolveInactivityDue/);
  assert.match(store, /if \(isInactivityDue\(match, nowMs\)\)/);
  // Per-seat clocks, so one player's activity cannot keep the other's alive.
  assert.match(store, /inactivityForfeitSeat\(match, nowMs\)/);
  assert.match(store, /p1LastActionAt/);
  assert.match(store, /p2LastActionAt/);
});

test("trust: the completion instant is stamped from the server clock", () => {
  const store = code(files.store);
  assert.match(store, /nextState\.completedAtMs = nowMs/);
});

// ── 4. Hidden information cannot leave the server ────────────────────────

test("secrecy: the server seed is exposed only when the match is terminal", () => {
  const store = code(files.store);
  assert.match(store, /serverSeed: terminal \? match\.serverSeed : null/);
  assert.match(store, /seedHash: match\.serverSeedHash/);
  // The public lobby entry must never carry the seed or the deal.
  const entry = store.slice(
    store.indexOf("export function lobbyEntry"),
    store.indexOf("export async function listOpenMatches"),
  );
  assert.ok(entry.length > 0, "lobbyEntry must exist and precede listOpenMatches");
  // The entry's EXACT field set: anything added here is a public leak until it
  // is consciously approved in this list.
  const fields = [...entry.matchAll(/^ {4}([a-zA-Z0-9]+):/gm)].map((match) => match[1]);
  assert.deepEqual(fields, [
    "matchId",
    "variant",
    "status",
    "open",
    "seedHash",
    "createdAtMs",
    "serverNow",
  ]);
  assert.doesNotMatch(entry, /serverSeed:|\bdeal:|State:/);
});

test("secrecy: a client DTO is projected field by field, never spread", () => {
  const store = code(files.store);
  const dto = store.slice(
    store.indexOf("export function matchToDto"),
    store.indexOf("export function lobbyEntry"),
  );
  assert.ok(dto.length > 0, "matchToDto must exist and precede lobbyEntry");
  // A spread of the row would leak the opponent's board and the stock order.
  assert.doesNotMatch(dto, /\.\.\.match/, "the DTO must not spread the match row");
  assert.doesNotMatch(dto, /p1State|p2State|stock:/, "the DTO must not carry raw boards");
  // The opponent's board is replaced by the closed progress shape.
  assert.match(dto, /opponentProgressFor\(opponentSeat, otherState\)/);
});

test("secrecy: the view strips face-down identities and the stock order", () => {
  const rules = code(files.rules);
  const view = rules.slice(
    rules.indexOf("export function viewForState"),
    rules.indexOf("export function opponentProgressFor"),
  );
  assert.match(view, /return \{ faceUp: false, card: null \}/);
  assert.match(view, /stockCount: state\.stock\?\.length \?\? 0/);
  // The opponent shape is counts and status only.
  const opponent = rules.slice(
    rules.indexOf("export function opponentProgressFor"),
    rules.indexOf("export function outcomeFor"),
  );
  for (const forbidden of ["tableau", "stock", "waste", "deal"]) {
    assert.doesNotMatch(opponent, new RegExp(`\\b${forbidden}\\b`), `OpponentProgress must not expose ${forbidden}`);
  }
});

test("secrecy: the engine never resolves a face-down card into a move", () => {
  const rules = code(files.rules);
  const run = rules.slice(
    rules.indexOf("export function faceUpRunFrom"),
    rules.indexOf("export type MoveValidation"),
  );
  // A hidden head is simply not found — an identity cannot address a hidden card.
  assert.match(run, /pile\.faceUp && sameCard\(pile\.card, head\)/);
  assert.match(run, /if \(index < 0\) return null/);
  assert.match(run, /if \(!pile\.faceUp \|\| !pile\.card\) return null/);
});

// ── 5. Storage invariants ─────────────────────────────────────────────────

test("storage: the move log makes replay-structural guarantees", () => {
  const sql = sqlCode("src/db/migrations/0193_solitaire_duel.sql");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS solitaire_duel_moves_ply_unique/);
  assert.match(sql, /ON solitaire_duel_moves\(match_id, seat, ply\)/);
  assert.match(sql, /seat VARCHAR\(10\) NOT NULL\s*CHECK \(seat IN \('player1', 'player2'\)\)/);
  // The seed pair and both boards are required columns: a match without a
  // committed deal, or without two boards, cannot exist.
  assert.match(sql, /server_seed VARCHAR\(64\) NOT NULL/);
  assert.match(sql, /server_seed_hash VARCHAR\(64\) NOT NULL/);
  assert.match(sql, /deal JSONB NOT NULL/);
  assert.match(sql, /p1_state JSONB NOT NULL/);
  assert.match(sql, /p2_state JSONB NOT NULL/);
  // No money anywhere.
  assert.doesNotMatch(sql, /stake|prize|payout|house_fee/);
});

test("storage: the schema mirrors the migration", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /"solitaire_duel_matches"/);
  assert.match(schema, /"solitaire_duel_moves"/);
  assert.match(schema, /unique\("solitaire_duel_moves_ply_unique"\)\.on\(table\.matchId, table\.seat, table\.ply\)/);
  // The retired deadline column and its index must be gone.
  assert.doesNotMatch(schema, /solitaire_duel_matches_due_idx/);
});

test("storage: the retention sweep knows the new table", () => {
  const retention = read("src/app/api/jobs/retention/route.ts");
  assert.match(retention, /await purge\("solitaire_duel_matches", FINISHED\)/);
});
