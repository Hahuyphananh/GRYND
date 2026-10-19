// Tic-Tac-Toe: who opens, and the two pieces that make it visible.
//
// Three behaviours are pinned here, all reported from play:
//
//   1. the opening seat is no longer a fixed privilege — a duel ROLLS it (like
//      chess colours) and a practice match lets the player choose X, O or a
//      server-side random roll;
//   2. a bot that holds X must actually OPEN, because tic-tac-toe's bot normally
//      answers inside a human move's transaction and has no human move to ride
//      on;
//   3. a resolved mini-board is COVERED by an outcome overlay, and the lattice is
//      capped so all nine boards fit one screen instead of the bottom row sitting
//      below the fold.
//
// The pure helpers are exercised directly; the wiring is asserted against the
// real sources, matching the other per-game contract suites (the store needs a
// database and a second signed-in account for a PvP join).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  openingSeatIsHost,
  parseMarkChoice,
  resolveHumanMark,
} from "../src/lib/tic-tac-toe/seating.ts";
import {
  AI_MARKS,
  AI_MARK_HINTS,
  coerceAiMark,
} from "../src/lib/tic-tac-toe/marks.ts";
import {
  applyMove,
  createInitialState,
  seatForPly,
} from "../src/lib/tic-tac-toe/rules.ts";
import { chooseAiMove } from "../src/lib/tic-tac-toe/ai.ts";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const STORE = read("src/lib/tic-tac-toe/serverStore.ts");
const ROUTE = read("src/app/api/tic-tac-toe/create-ai/route.ts");
const LOBBY = read("src/app/casino/tic-tac-toe/PageClient.tsx");
const MARKS = read("src/lib/tic-tac-toe/marks.ts");
const MEGA = read("src/components/tic-tac-toe/MegaBoard.tsx");
const BOARD = read("src/components/tic-tac-toe/TicTacToeBoard.tsx");

// ── 1. The choice, and the roll ──────────────────────────────────────────

test("mark: an untrusted request can only ask for X, O or random", () => {
  assert.equal(parseMarkChoice("X"), "X");
  assert.equal(parseMarkChoice("o"), "O", "case is not the player's problem");
  assert.equal(parseMarkChoice(" O "), "O");
  assert.equal(parseMarkChoice("random"), "random");
  // Everything else is the documented default: let the server roll.
  for (const bad of [undefined, null, 3, {}, "white", "", "XO"]) {
    assert.equal(parseMarkChoice(bad), "random", `parseMarkChoice(${JSON.stringify(bad)})`);
  }
});

test("mark: a chosen mark is honoured exactly", () => {
  const never = () => {
    throw new Error("random must not be consulted for an explicit choice");
  };
  assert.equal(resolveHumanMark("X", never), "X");
  assert.equal(resolveHumanMark("O", never), "O");
});

test("mark: random is rolled on the server, and only ever X or O", () => {
  assert.equal(resolveHumanMark("random", () => 0), "X");
  assert.equal(resolveHumanMark("random", () => 0.499), "X");
  assert.equal(resolveHumanMark("random", () => 0.5), "O");
  assert.equal(resolveHumanMark("random", () => 0.999), "O");
  // Both outcomes are reachable, so the roll is a roll and not a constant.
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(resolveHumanMark("random"));
  assert.deepEqual([...seen].sort(), ["O", "X"]);
});

test("duel: the opening seat is rolled, not the host's privilege", () => {
  assert.equal(openingSeatIsHost(() => 0), true);
  assert.equal(openingSeatIsHost(() => 0.499), true);
  assert.equal(openingSeatIsHost(() => 0.5), false);
  assert.equal(openingSeatIsHost(() => 0.999), false);
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(openingSeatIsHost());
  assert.equal(seen.size, 2, "a host must sometimes answer rather than always open");
});

test("engine: X is still player1 and still opens — the roll moves SEATS, not the rules", () => {
  // The invariant every caller (replay included) relies on. The feature changes
  // which USER takes player1; it must not change what player1 means.
  const state = createInitialState();
  assert.equal(state.currentTurn, "player1");
  assert.equal(seatForPly(0), "player1");
  assert.equal(seatForPly(1), "player2");
});

// ── 2. The bot opens when it holds X ─────────────────────────────────────

test("practice: the chosen mark decides the seats, and a bot holding X opens", () => {
  // The bot's opening move, exactly as the store builds it before insert.
  let state = createInitialState();
  const aiSeat = state.currentTurn;
  const move = chooseAiMove({ state, seat: aiSeat, difficulty: "normal" });
  assert.ok(move, "an empty board always offers the bot a move");
  const applied = applyMove({
    state,
    seat: aiSeat,
    boardIndex: move.boardIndex,
    cellIndex: move.cellIndex,
  });

  assert.equal(applied.state.ply, 1, "the bot's opening move is a real ply");
  assert.equal(applied.state.currentTurn, "player2", "the human answers");
  assert.equal(applied.state.lastMove?.mark, "X", "the bot's mark is X");
  assert.equal(applied.boardResolved, false);
});

test("practice: the store seats the human by MARK and logs the bot's opening move", () => {
  // Human O → the bot is player1 and owns the opening move.
  assert.ok(
    STORE.includes('let humanSeat: Seat = humanMark === "X" ? "player1" : "player2";'),
    "the human's seat must follow the resolved mark",
  );
  assert.ok(
    STORE.includes("if (state.currentTurn !== humanSeat) {"),
    "a bot holding the first turn must be detected at creation",
  );
  assert.ok(
    STORE.includes("const move = chooseAiMove({ state, seat: state.currentTurn, difficulty: tier });"),
    "the bot's opening move must be the same policy that answers mid-match",
  );
  // …and it is persisted like any other move, so replay reconstructs it.
  const createStart = STORE.indexOf("export async function createAiMatch");
  const createBody = STORE.slice(createStart, createStart + 3600);
  assert.ok(createBody.includes("await tx.insert(ticTacToeMoves).values({"));
  assert.ok(createBody.includes("playerId: TIC_TAC_TOE_AI_PLAYER_ID"));
  assert.ok(createBody.includes("ply: 0"), "the opening move is ply 0");
  // The seats written to the row are the resolved ones, never `userId` first.
  assert.ok(createBody.includes("player1Id: seats.player1Id"));
  assert.ok(createBody.includes("player2Id: seats.player2Id"));

  // A duel rolls the seats at join, after both stakes are escrowed.
  assert.ok(
    STORE.includes("const seats: Seats = openingSeatIsHost()"),
    "the join must roll which human opens",
  );
  const joinStart = STORE.indexOf("async function joinExistingMatch");
  const joinBody = STORE.slice(joinStart, joinStart + 4200);
  assert.ok(
    joinBody.indexOf("escrowMatchWagers") < joinBody.indexOf("openingSeatIsHost()"),
    "both seats are funded before the roll decides which one opens",
  );
  assert.ok(
    joinBody.includes("player1Id: seats.player1Id") && joinBody.includes("player2Id: seats.player2Id"),
    "the rolled seats are the ones persisted",
  );
});

test("practice route: the mark travels from the body to the store, and the answer echoes it", () => {
  assert.ok(ROUTE.includes("mark?: unknown;"));
  assert.ok(ROUTE.includes("mark: body?.mark"));
  assert.ok(ROUTE.includes("humanMark,"), "the resolved mark is returned");
  assert.ok(ROUTE.includes("humanSeat,"), "the resolved seat is returned");
});

// ── 3. The lobby dialog ──────────────────────────────────────────────────

test("lobby: Play vs AI opens a settings dialog with the mark and the tier", () => {
  // The button opens the dialog; it no longer starts a match on click.
  assert.ok(
    LOBBY.includes("onClick={() => setAiSetupOpen(true)}"),
    "Play Free vs AI must open the setup dialog",
  );
  assert.ok(LOBBY.includes('role="dialog"'));
  assert.ok(LOBBY.includes('aria-modal="true"'));
  // Both settings, and both go to the server with the create request.
  assert.ok(LOBBY.includes("AI_MARKS.map((choice) => {"));
  assert.ok(LOBBY.includes("AiDifficultyPicker"), "the shared tier picker is reused");
  assert.ok(
    LOBBY.includes("body: JSON.stringify({ difficulty: aiDifficulty, mark: aiMark })"),
    "the choice must be part of the create request",
  );
  // A stale preference must never break the lobby.
  assert.ok(MARKS.includes("try {") && MARKS.includes("catch"));
  assert.deepEqual([...AI_MARKS], ["X", "O", "random"]);
  for (const mark of AI_MARKS) assert.ok(AI_MARK_HINTS[mark].length > 10);
  assert.equal(coerceAiMark("nope"), "random");
});

// ── 4. The board: covered outcomes and one-screen sizing ─────────────────

test("board: the mark glyph is shared with the overlay, not redrawn", () => {
  assert.ok(BOARD.includes("export function MarkGlyph("), "the glyph must be importable");
  assert.ok(MEGA.includes('import TicTacToeBoard, { MarkGlyph } from "./TicTacToeBoard";'));
});

test("board: a resolved mini-board is covered by a huge outcome overlay", () => {
  assert.ok(MEGA.includes("lattice-board-overlay-${slot}"), "the overlay is addressable");
  assert.ok(MEGA.includes('data-outcome={ownerMark ?? "draw"}'));
  // The outcome glyph is the board's own silhouette, at 74% of the playfield.
  assert.ok(MEGA.includes("<MarkGlyph mark={ownerMark} className=\"h-full w-full\" />"));
  assert.ok(MEGA.includes("h-[74%] w-[74%]"));
  // It is an OVERLAY: inert, and above the cells (which stay mounted so their
  // marks and the winning line are still underneath).
  assert.ok(MEGA.includes("pointer-events-none absolute inset-0 z-[4]"));
  assert.ok(MEGA.includes("bg-[#050a14]/60"));
  // A draw is covered too, with a word instead of a mark.
  assert.ok(MEGA.includes('state === "drawn"'), "a drawn board is overlaid as well");
  assert.ok(MEGA.includes("Draw"), "and says so in the overlay");
  // Reduced motion still paints the outcome.
  assert.ok(MEGA.includes("withReducedMotion(reduceMotion, {"));
});

test("board: the lattice is capped by the room left on screen, not by the column alone", () => {
  // The reserve is 400px: the desktop match page is exactly one viewport tall
  // and no longer scrolls, the controls moved to the sidebar and the rules strip
  // is desktop-hidden. That frees room for a bigger lattice (500px and ~47px
  // cells at 1280×900, up from 480px and 43px). Verified in a real browser by
  // `npm run verify:tic-tac-toe-mobile`, which asserts the lattice's bottom edge
  // stays inside the viewport at 1280×900 AND 1280×800, with and without the
  // transient banner — the bottom row must never need a scroll.
  assert.ok(
    MEGA.includes('maxWidth: "min(calc(100% - 20px), max(300px, calc(100svh - 400px)))"'),
    "the lattice must shrink with the viewport height and inset slightly from the column so the bottom row stays on screen",
  );
  // The floor keeps it from being crushed on a very short window.
  assert.ok(MEGA.includes("max(300px"));
});

test("match page: the chrome above the lattice is compact, and nothing was removed", () => {
  const page = read("src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx");
  // The seat cards, turn guidance and controls all survive — they are just
  // tighter, because every pixel above the board is a pixel the board loses.
  assert.ok(page.includes('data-testid={`seat-${seat}`}'));
  assert.ok(page.includes('data-testid="turn-status"'));
  assert.ok(page.includes('data-testid="board-event"'));
  assert.ok(page.includes('className="mb-2 grid grid-cols-2 gap-2"'));
});
