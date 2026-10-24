/**
 * dominoes-online-ui.test.mjs
 *
 * THE ONLINE DOMINOES SURFACE — the half of the game a browser test cannot see
 * cheaply, plus the board rendered for real through React's server renderer.
 *
 * What this file proves:
 *
 *   1. HIDDEN INFORMATION STAYS HIDDEN IN THE MARKUP. `DominoMatchView` is
 *      rendered once per seat from the same class of payload the API returns, and
 *      the opponent's tiles and the pile's contents must appear in NEITHER view —
 *      only their counts.
 *   2. THE CONTROLS FOLLOW THE SERVER'S SNAPSHOT: whose turn it is, which ends a
 *      selected tile fits, drawing vs passing, pending, reconnecting, terminal.
 *   3. THE COUNTDOWN IS A DISPLAY of the server's stamped instant — including the
 *      "time is up" state — and never a local decision.
 *   4. AUTHORITY IS VISIBLE IN THE TRANSPORT: the only gameplay request is an
 *      action plus `expectedVersion`; nothing a client could claim (hand, chain,
 *      turn, winner, result) is ever posted.
 *   5. THE LIVE CHANNEL IS THE EXISTING ONE: the `dominoes:match:<id>` room, the
 *      generic `lobby:updated` relay, the `dominoes:ready` poke, and the realtime
 *      server's graceful-disconnect forfeit — with the room literals pinned
 *      between the TypeScript vocabulary and the plain CommonJS server.
 *   6. NO POLLING: the match page arms one bounded deadline read and one read per
 *      socket reconnect / tab focus, and contains no interval at all.
 *
 * Run:  node --import tsx --test tests/dominoes-online-ui.test.mjs
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as handModule from "../src/components/dominoes/DominoHand.tsx";
import * as chainModule from "../src/components/dominoes/DominoChain.tsx";
import {
  availableActions,
  countdownFor,
  isIncomingSnapshotStale,
  isTerminalStatus,
  legalEndsFor,
  loggedActionLabel,
  outcomeFor,
  playOptionsFor,
  resultReasonLabel,
  seatLabel,
  statusLabel,
  tileCountLabel,
  tileLabel,
  tileParts,
  turnLabel,
} from "../src/lib/dominoes/ui.ts";
import {
  DOMINOES_LOBBY_ROOM,
  DOMINOES_MATCH_ROOM_PREFIX,
  DOMINOES_MATCH_UPDATED,
  DOMINOES_READY,
  broadcastMatchUpdate,
  dominoesMatchRoom,
} from "../src/lib/dominoes/rooms.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The same source with `//` and `/* … *​/` commentary removed. */
function stripComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

// tsx wraps a .tsx default import as `mod.default.default` in some interop shapes.
const pick = (mod) => mod?.default?.default ?? mod?.default ?? mod;
const DominoHand = pick(handModule);
const DominoChain = pick(chainModule);

// ── Why the seat avatar is mocked ──────────────────────────────────────────
// `SeatAvatar` imports a PNG for the bot face, and Node cannot load a PNG as a
// module — which would fail this file for a reason that has nothing to do with
// dominoes. The avatar is a leaf presentational component (it draws a name, an
// icon and a frame), so the board renders with a stand-in here and the REAL
// component is what ships. Everything else in the tree is the shipped code.
const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run with --experimental-test-module-mocks";
function SeatAvatarStub({ name }) {
  return React.createElement("span", { "data-testid": "seat-avatar" }, String(name ?? ""));
}
// tsx's CJS interop can hand a default import either the function or a namespace
// object wrapping it, so the stub is its own default.
SeatAvatarStub.default = SeatAvatarStub;

if (MODULE_MOCKING_AVAILABLE) {
  mock.module("../src/components/game/SeatAvatar.tsx", {
    namedExports: { default: SeatAvatarStub, __esModule: true },
  });
}

const matchViewModule = MODULE_MOCKING_AVAILABLE
  ? await import("../src/components/dominoes/DominoMatchView.tsx")
  : null;
const DominoMatchView = matchViewModule ? pick(matchViewModule) : null;

const MATCH_PAGE = "src/app/casino/dominoes/[matchId]/PageClient.tsx";
const MATCH_ROUTE = "src/app/casino/dominoes/[matchId]/page.tsx";
const LOBBY_PAGE = "src/app/casino/dominoes/PageClient.tsx";
const LOBBY_ROUTE = "src/app/casino/dominoes/page.tsx";
const REALTIME = "realtime-server/server.js";
const PROXY = "src/proxy.ts";
const CSS = "src/app/globals.css";

const page = read(MATCH_PAGE);
const pageCode = stripComments(page);
const lobby = read(LOBBY_PAGE);
const lobbyCode = stripComments(lobby);
const realtime = read(REALTIME);
const css = read(CSS);
const proxy = read(PROXY);

/* -------------------------------------------------------------------------- *
 * Fixtures — the same shape the API returns
 * -------------------------------------------------------------------------- */

const ALICE = "user_alice";
const BOB = "user_bob";
const DEADLINE = "2026-10-22T12:00:15.000Z";
/** Three seconds into a fifteen-second turn. */
const NOW = Date.parse("2026-10-22T12:00:03.000Z");

const HANDS = {
  player1: ["6-3", "1-1", "2-2"],
  player2: ["6-6", "5-5", "0-0"],
};
/** The face-down pile — its contents must never reach a client. */
const PILE = ["4-4", "3-1", "3-2"];

const CHAIN = [{ id: "6-5", end: "left", left: 6, right: 5, isDouble: false, seat: "player2" }];

function snapshotFor(seat, overrides = {}) {
  const opponent = seat === "player1" ? "player2" : "player1";
  return {
    matchId: "99999999-9999-4999-8999-999999999999",
    status: "playing",
    version: 1,
    ply: 1,
    viewerSeat: seat,
    opponentSeat: opponent,
    isLive: true,
    isViewerTurn: seat === "player1",
    hand: [...HANDS[seat]],
    chain: CHAIN,
    openEnds: { left: 6, right: 5 },
    turn: "player1",
    turnDeadlineAt: DEADLINE,
    opponentTileCount: HANDS[opponent].length,
    drawPileCount: PILE.length,
    result: null,
    winnerId: null,
    resultReason: null,
    player1Id: ALICE,
    player2Id: BOB,
    startedAt: "2026-10-22T12:00:00.000Z",
    endedAt: null,
    players: {
      player1: { name: "Alice", iconKey: null, profileFrame: null },
      player2: { name: "Bob", iconKey: null, profileFrame: null },
    },
    ...overrides,
  };
}

const noop = () => {};

function renderView(props) {
  return renderToStaticMarkup(
    React.createElement(DominoMatchView, {
      snapshot: snapshotFor("player1"),
      nowMs: NOW,
      ...props,
    }),
  );
}

/** The opening tag of the element carrying `testid` (`<button …>`), or null. */
function tagWith(html, testid) {
  const index = html.indexOf(`data-testid="${testid}"`);
  if (index === -1) return null;
  const start = html.lastIndexOf("<", index);
  const end = html.indexOf(">", index);
  return html.slice(start, end + 1);
}

const isDisabled = (html, testid) => /(\sdisabled=""|\sdisabled=)/.test(tagWith(html, testid) ?? "");

/** The element's INNER html (what it renders), for "which icon and value" checks. */
function innerWith(html, testid) {
  const at = html.indexOf(`data-testid="${testid}"`);
  if (at === -1) return null;
  const from = html.indexOf(">", at) + 1;
  const to = html.indexOf("</span>", at);
  return html.slice(from, to);
}

/* -------------------------------------------------------------------------- *
 * 1. Both seats, and nothing that is not theirs
 * -------------------------------------------------------------------------- */

test("dominoes ui: each seat's board shows its own hand and only the opponent's COUNT", { skip: SKIP_REASON }, () => {
  const asAlice = renderView({ snapshot: snapshotFor("player1") });
  const asBob = renderView({ snapshot: snapshotFor("player2") });

  // Each seat holds its own three tiles…
  for (const tile of HANDS.player1) {
    assert.ok(asAlice.includes(`data-tile="${tile}"`), `player1 must see ${tile}`);
    assert.equal(asBob.includes(`data-tile="${tile}"`), false, `${tile} leaked to player2`);
  }
  for (const tile of HANDS.player2) {
    assert.ok(asBob.includes(`data-tile="${tile}"`), `player2 must see ${tile}`);
    assert.equal(asAlice.includes(`data-tile="${tile}"`), false, `${tile} leaked to player1`);
  }

  // …and the pile's contents are in neither view.
  for (const tile of PILE) {
    assert.equal(asAlice.includes(`data-tile="${tile}"`), false, `pile tile ${tile} leaked`);
    assert.equal(asBob.includes(`data-tile="${tile}"`), false, `pile tile ${tile} leaked`);
  }

  // The counts ARE public, and printed for both.
  assert.match(asAlice, /data-testid="dominoes-opponent-count"[^>]*>3 tiles left/);
  assert.match(asAlice, /data-testid="dominoes-pile-count"[^>]*>3 tiles/);
  assert.match(asAlice, /data-testid="dominoes-hand-count"[^>]*>3 tiles/);

  // The chain is shared: both seats see the same played tile.
  assert.ok(asAlice.includes('data-tile="6-5"'));
  assert.ok(asBob.includes('data-tile="6-5"'));

  // The seat is the server's, and it drives the whole projection.
  assert.match(asAlice, /data-viewer-seat="player1"/);
  assert.match(asBob, /data-viewer-seat="player2"/);
  // …and "your turn" follows `isViewerTurn`, not the seat number.
  assert.match(asAlice, /data-viewer-turn="true"/);
  assert.match(asBob, /data-viewer-turn="false"/);
});

test("dominoes ui: the turn banner names the opponent and follows the server's flag", { skip: SKIP_REASON }, () => {
  const mine = renderView({ snapshot: snapshotFor("player1") });
  assert.match(mine, /data-testid="dominoes-status"[^>]*>Your turn/);

  const theirs = renderView({ snapshot: snapshotFor("player2") });
  assert.match(theirs, /data-testid="dominoes-status"[^>]*>Alice is deciding/);
  assert.match(theirs, /data-testid="dominoes-opponent-turn-badge"/);
});

/* -------------------------------------------------------------------------- *
 * 2. Legal-move controls
 * -------------------------------------------------------------------------- */

test("dominoes ui: the end buttons follow the selected tile and the open values", { skip: SKIP_REASON }, () => {
  // "6-3" matches the left end (6) but not the right (5).
  const withSix = renderView({ selected: "6-3" });
  assert.equal(isDisabled(withSix, "dominoes-play-left"), false, "left must be offered");
  assert.equal(isDisabled(withSix, "dominoes-play-right"), true, "right must be refused");
  assert.match(withSix, /aria-label="Play left, open value 6"/);
  // The button prints the value it attaches to, so the choice is unambiguous.
  assert.match(withSix, /class="dominoes-action-value"[^>]*>6</);

  // "1-1" matches neither end: both placements are refused.
  const withOne = renderView({ selected: "1-1" });
  assert.equal(isDisabled(withOne, "dominoes-play-left"), true);
  assert.equal(isDisabled(withOne, "dominoes-play-right"), true);
  assert.match(withOne, /fits neither open end/);

  // Nothing selected: no placement at all, only the draw/pass pair.
  const idle = renderView({});
  assert.equal(tagWith(idle, "dominoes-play-left"), null);
  assert.equal(tagWith(idle, "dominoes-play-right"), null);
  assert.match(idle, /Select a tile from your hand/);
});

test("dominoes ui: an empty chain offers the single opening play", { skip: SKIP_REASON }, () => {
  const html = renderView({
    snapshot: snapshotFor("player1", { chain: [], openEnds: { left: null, right: null } }),
    selected: "1-1",
  });
  assert.ok(tagWith(html, "dominoes-play-open"), "the opener gets one Play button");
  assert.equal(isDisabled(html, "dominoes-play-open"), false);
  assert.equal(tagWith(html, "dominoes-play-left"), null);
  assert.match(html, /This opens the chain/);
  assert.match(html, /data-testid="dominoes-chain-empty"/);
});

test("dominoes ui: draw is offered only when nothing fits, pass only when the pile is empty", { skip: SKIP_REASON }, () => {
  // A hand that matches nothing, with tiles in the pile.
  const stuck = renderView({
    snapshot: snapshotFor("player1", { hand: ["1-1", "2-2"], openEnds: { left: 6, right: 5 } }),
  });
  assert.equal(isDisabled(stuck, "dominoes-draw"), false, "drawing must be offered");
  assert.equal(isDisabled(stuck, "dominoes-pass"), true, "passing before the pile is empty is not");
  assert.match(stuck, /Nothing in your hand fits/);

  // Same hand, empty pile: the pass is the only option.
  const dry = renderView({
    snapshot: snapshotFor("player1", {
      hand: ["1-1", "2-2"],
      openEnds: { left: 6, right: 5 },
      drawPileCount: 0,
    }),
  });
  assert.equal(isDisabled(dry, "dominoes-draw"), true);
  assert.equal(isDisabled(dry, "dominoes-pass"), false);
  assert.match(dry, /the pile is empty/);

  // With a playable tile in hand, NEITHER is allowed — you must play.
  const mustPlay = renderView({ snapshot: snapshotFor("player1") });
  assert.equal(isDisabled(mustPlay, "dominoes-draw"), true);
  assert.equal(isDisabled(mustPlay, "dominoes-pass"), true);
});

test("dominoes ui: a seat that is not on turn can submit nothing", { skip: SKIP_REASON }, () => {
  const html = renderView({ snapshot: snapshotFor("player2"), selected: null });
  for (const testid of ["dominoes-draw", "dominoes-pass"]) {
    assert.equal(isDisabled(html, testid), true, `${testid} must be disabled off-turn`);
  }
  assert.match(html, /Waiting for your opponent to move\./);
  // Its own hand is still visible and selectable — it just cannot act.
  for (const tile of HANDS.player2) {
    assert.ok(html.includes(`data-tile="${tile}"`));
  }
});

test("dominoes ui: a pending submission disables every control", { skip: SKIP_REASON }, () => {
  const html = renderView({ selected: "6-3", pending: true });
  assert.equal(isDisabled(html, "dominoes-play-left"), true);
  assert.equal(isDisabled(html, "dominoes-draw"), true);
  assert.equal(isDisabled(html, "dominoes-pass"), true);
  assert.match(html, /Sending your move/);
});

/* -------------------------------------------------------------------------- *
 * 3. The clock
 * -------------------------------------------------------------------------- */

test("dominoes ui: the countdown is drawn from the server's stamped instant", { skip: SKIP_REASON }, () => {
  const html = renderView({ nowMs: NOW });
  assert.match(html, /data-testid="dominoes-countdown"[^>]*>12s/);
  // A live region that announced every tick would be unusable with a screen
  // reader, so the seconds are NOT announced automatically.
  const value = tagWith(html, "dominoes-countdown");
  assert.match(value, /role="timer"/);
  assert.match(value, /aria-live="off"/);
  assert.match(value, /aria-label="12 seconds left on this turn"/);

  const countdown = countdownFor(DEADLINE, NOW);
  assert.equal(countdown.seconds, 12);
  assert.equal(countdown.expired, false);
  // The bar is the fraction of the 15-second window still to run.
  assert.match(html, /style="width:80%"/);
});

test("dominoes ui: an elapsed deadline says so and never acts for the player", { skip: SKIP_REASON }, () => {
  const late = Date.parse(DEADLINE) + 500;
  const html = renderView({ nowMs: late });
  assert.match(html, /data-testid="dominoes-countdown"[^>]*>Time&#x27;s up|Time's up/);
  assert.match(html, /is-expired/);
  // The board is unchanged: no tile moved, nothing was drawn locally.
  for (const tile of HANDS.player1) assert.ok(html.includes(`data-tile="${tile}"`));

  const countdown = countdownFor(DEADLINE, late);
  assert.equal(countdown.expired, true);
  assert.equal(countdown.seconds, 0);
  // A missing deadline is "no clock", not "expired".
  assert.equal(countdownFor(null, NOW).expired, false);
  assert.equal(countdownFor(null, NOW).label, "—");
  // The first second of a 15s window reads 15, not 14.
  assert.equal(countdownFor(DEADLINE, Date.parse(DEADLINE) - 15_000).seconds, 15);
});

test("dominoes ui: a decided match has no clock and offers no resign", { skip: SKIP_REASON }, () => {
  const html = renderView({
    snapshot: snapshotFor("player1", {
      status: "finished",
      isLive: false,
      isViewerTurn: false,
      turnDeadlineAt: null,
      result: "player1",
      winnerId: ALICE,
      resultReason: "emptied-hand",
      hand: [],
    }),
  });
  assert.equal(tagWith(html, "dominoes-clock"), null, "a settled round shows no countdown");
  assert.equal(tagWith(html, "dominoes-resign"), null, "there is nothing left to resign");
  assert.match(html, /data-live="false"/);
  assert.match(html, /data-testid="dominoes-lifecycle"[^>]*>Finished/);
  assert.match(html, /data-testid="dominoes-hand-empty"/);
  assert.equal(isDisabled(html, "dominoes-draw"), true);
});

/* -------------------------------------------------------------------------- *
 * 4. Notices, reconnection, accessibility
 * -------------------------------------------------------------------------- */

test("dominoes ui: a refusal is shown without corrupting the board", { skip: SKIP_REASON }, () => {
  const html = renderView({ notice: "That turn has expired — the clock acted for you" });
  const notice = tagWith(html, "dominoes-notice");
  assert.match(notice, /is-visible/);
  assert.match(html, /That turn has expired/);
  // The position is still the snapshot's: nothing was rolled back locally.
  assert.ok(html.includes('data-tile="6-5"'));
});

test("dominoes ui: a dropped live link is announced but never blocks a move", { skip: SKIP_REASON }, () => {
  const html = renderView({ reconnecting: true, selected: "6-3" });
  assert.match(html, /data-testid="dominoes-reconnect"/);
  assert.match(html, /Live updates paused/);
  // The socket only says "something changed, re-read": every read and every
  // action is HTTP, so losing it costs freshness, not the ability to play. A
  // board that froze here was the bug that made a match look deactivated.
  assert.equal(isDisabled(html, "dominoes-play-left"), false);
  assert.equal(isDisabled(html, "dominoes-hand-tile"), false);
});

test("dominoes ui: the board is a real control surface, not a picture", { skip: SKIP_REASON }, () => {
  const html = renderView({ selected: "6-3" });

  // Hand tiles are buttons with a pressed state and a name.
  const tile = tagWith(html, "dominoes-hand-tile");
  assert.match(tile, /^<button/);
  assert.match(tile, /aria-pressed="true"/);
  assert.match(tile, /aria-label="Tile 6–3, playable"/);

  // The chain is an ordered list of images, so it reads as a position.
  assert.match(html, /role="list"/);
  assert.match(html, /role="listitem"/);
  const chainTile = tagWith(html, "dominoes-chain-tile");
  assert.match(chainTile, /role="img"/);
  assert.match(chainTile, /aria-label="6–5"/);

  // The two open values are printed at the ends, with an ICON (not a text arrow)
  // pointing at the direction each one opens — the same Tabler icons the rest of
  // the app uses.
  const leftChip = innerWith(html, "dominoes-open-left");
  const rightChip = innerWith(html, "dominoes-open-right");
  assert.match(leftChip, /tabler-icon-arrow-left/);
  assert.equal(leftChip.trimEnd().endsWith("6"), true, "the left chip prints its open value");
  assert.match(rightChip, /tabler-icon-arrow-right/);
  assert.equal(rightChip.trimStart().startsWith("5"), true, "the right chip prints its open value");
  // No emoji/text arrows anywhere on the board: the direction cues are icons.
  assert.equal(/[◀▶←→]/.test(html), false, "the board must use icons, not arrow glyphs");

  // The rules are a disclosure, so they can be read mid-match.
  assert.match(html, /<details[^>]*data-testid="dominoes-rules"/);
  assert.match(html, /How to play Dominoes/);
  assert.match(html, /15 seconds a turn/);
});

test("dominoes ui: the chain says which end the last tile went on", { skip: SKIP_REASON }, () => {
  const right = renderView({
    snapshot: snapshotFor("player1", {
      chain: [
        { id: "6-5", end: "left", left: 6, right: 5, isDouble: false, seat: "player2" },
        { id: "5-0", end: "right", left: 5, right: 0, isDouble: false, seat: "player1" },
      ],
      openEnds: { left: 6, right: 0 },
    }),
  });
  // The marker's whole element: from its own test id to the tile that follows
  // it (its body nests a span, so "up to the next </span>" would cut the icon).
  const markerSlice = (html) => {
    const start = html.indexOf('data-testid="dominoes-last-marker"');
    assert.notEqual(start, -1, "the last play must be marked");
    const end = html.indexOf('data-testid="dominoes-chain-tile"', start);
    return html.slice(start, end);
  };

  const marker = tagWith(right, "dominoes-last-marker");
  assert.match(marker, /data-end="right"/);
  assert.match(marker, /aria-label="Last tile played, on the right"/);
  assert.match(markerSlice(right), /tabler-icon-arrow-right/);
  assert.match(markerSlice(right), />right</);

  const left = renderView({
    snapshot: snapshotFor("player1", {
      chain: [
        { id: "6-5", end: "left", left: 6, right: 5, isDouble: false, seat: "player2" },
        { id: "6-6", end: "left", left: 6, right: 6, isDouble: false, seat: "player1" },
      ],
      openEnds: { left: 6, right: 5 },
    }),
  });
  assert.match(tagWith(left, "dominoes-last-marker") ?? "", /data-end="left"/);
  assert.match(left, /aria-label="Last tile played, on the left"/);
  assert.match(markerSlice(left), /tabler-icon-arrow-left/);
  assert.match(markerSlice(left), />left</);

  // The opening tile opens the line rather than choosing a side, so a one-tile
  // chain carries no marker.
  assert.equal(tagWith(renderView({}), "dominoes-last-marker"), null);
});

test("dominoes ui: the chain renders the engine's order and marks a double", () => {
  const html = renderToStaticMarkup(
    React.createElement(DominoChain, {
      chain: [
        { id: "6-5", left: 6, right: 5, seat: "player1" },
        { id: "5-5", left: 5, right: 5, isDouble: true, seat: "player2" },
        { id: "5-0", left: 5, right: 0, seat: "player1" },
      ],
      openEnds: { left: 6, right: 0 },
      isLive: true,
    }),
  );
  const ids = [...html.matchAll(/data-tile="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["6-5", "5-5", "5-0"], "the line is the engine's own array order");
  assert.match(html, /is-double/);
  assert.match(html, /data-chain-length="3"/);
});

/* -------------------------------------------------------------------------- *
 * 5. Pure view-model helpers
 * -------------------------------------------------------------------------- */

test("dominoes ui: lifecycle copy follows the server's status", () => {
  assert.equal(statusLabel("waiting"), "Waiting for an opponent");
  assert.equal(statusLabel("playing"), "In progress");
  assert.equal(statusLabel("finished"), "Finished");
  assert.equal(statusLabel("cancelled"), "Cancelled");
  assert.equal(statusLabel(undefined), "Loading");

  assert.equal(isTerminalStatus("finished"), true);
  assert.equal(isTerminalStatus("cancelled"), true);
  assert.equal(isTerminalStatus("playing"), false);

  assert.match(turnLabel({ status: "waiting" }), /waiting for an opponent/i);
  assert.match(turnLabel({ status: "playing", isViewerTurn: true, viewerSeat: "player1" }), /your turn/i);
  assert.equal(
    turnLabel({ status: "playing", isViewerTurn: false, viewerSeat: "player1", opponentName: "Bob" }),
    "Bob is deciding…",
  );
  assert.match(turnLabel({ status: "playing" }), /loading/i);
  assert.equal(seatLabel("player1", "player1"), "You");
  assert.equal(seatLabel("player2", "player1"), "Opponent");
});

test("dominoes ui: the outcome keeps a DRAW, and comes from the settled row", () => {
  assert.equal(outcomeFor({ result: "player1", viewerSeat: "player1" }), "win");
  assert.equal(outcomeFor({ result: "player1", viewerSeat: "player2" }), "loss");
  assert.equal(outcomeFor({ result: "player2", viewerSeat: "player2" }), "win");
  // A blocked round on equal pips is a real draw — not a loss for both seats.
  assert.equal(outcomeFor({ result: "draw", viewerSeat: "player1" }), "draw");
  assert.equal(outcomeFor({ result: "draw", viewerSeat: "player2" }), "draw");
  // A row that names a winner without a result falls back to the SERVER's id for
  // the viewer's seat (never to Clerk alone).
  assert.equal(outcomeFor({ winnerId: ALICE, viewerSeat: "player1", userId: ALICE }), "win");
  assert.equal(outcomeFor({ winnerId: BOB, viewerSeat: "player1", userId: ALICE }), "loss");
  assert.equal(outcomeFor({ result: null, winnerId: null, viewerSeat: "player1" }), null);
  assert.equal(outcomeFor({ result: "player1", viewerSeat: null }), null);

  assert.match(resultReasonLabel("emptied-hand", "win"), /played your last tile/i);
  assert.match(resultReasonLabel("emptied-hand", "loss"), /opponent played their last tile/i);
  assert.match(resultReasonLabel("blocked-pips", "draw"), /counted the same/i);
  assert.match(resultReasonLabel("blocked-pips", "win"), /opponent had more pips/i);
  assert.match(resultReasonLabel("resigned", "win"), /opponent resigned/i);
  assert.match(resultReasonLabel("abandoned", "loss"), /you left/i);
});

test("dominoes ui: tile helpers stay canonical and pluralise", () => {
  assert.deepEqual(tileParts("6-3"), [6, 3]);
  assert.deepEqual(tileParts("0-0"), [0, 0]);
  // The splitter is for DRAWING and accepts either half order; canonicalising a
  // tile id (`"3-6"` is not a tile of the set) is the engine's `isTileId`, which
  // runs on the server before any action is applied.
  assert.deepEqual(tileParts("3-6"), [3, 6]);
  assert.equal(tileParts("7-1"), null);
  assert.equal(tileParts(null), null);
  assert.equal(tileLabel("6-3"), "6–3");
  assert.equal(tileLabel("garbage"), "garbage");
  assert.equal(tileCountLabel(14), "14 tiles");
  assert.equal(tileCountLabel(1), "1 tile");
  assert.equal(tileCountLabel(0), "0 tiles");
  assert.equal(tileCountLabel(undefined), "0 tiles");
});

test("dominoes ui: which ends a tile fits is read from the public open values", () => {
  assert.deepEqual(legalEndsFor("6-3", { left: 6, right: 5 }), ["left"]);
  assert.deepEqual(legalEndsFor("3-5", { left: 6, right: 5 }), ["right"]);
  // A double can fit both, because either half matches.
  assert.deepEqual(legalEndsFor("5-5", { left: 6, right: 5 }), ["right"]);
  assert.deepEqual(legalEndsFor("6-6", { left: 6, right: 6 }), ["left", "right"]);
  assert.deepEqual(legalEndsFor("1-1", { left: 6, right: 5 }), []);
  assert.deepEqual(legalEndsFor("6-3", null), []);

  // An empty chain accepts the whole hand, on the opening (left) end.
  const opening = playOptionsFor(["6-3", "1-1"], { left: null, right: null }, true);
  assert.deepEqual(opening, [
    { tile: "6-3", ends: ["left"] },
    { tile: "1-1", ends: ["left"] },
  ]);
  // A live chain accepts only what fits.
  assert.deepEqual(playOptionsFor(["6-3", "1-1"], { left: 6, right: 5 }, false), [
    { tile: "6-3", ends: ["left"] },
  ]);
});

test("dominoes ui: draw and pass availability mirror the engine's rule", () => {
  const base = { openEnds: { left: 6, right: 5 }, chainEmpty: false };
  // Something fits → you must play, and neither button is offered.
  assert.deepEqual(
    availableActions({ ...base, hand: ["6-3"], drawPileCount: 5, isViewerTurn: true }),
    { canDraw: false, canPass: false, mustPlay: true },
  );
  // Nothing fits, pile non-empty → draw only.
  assert.deepEqual(
    availableActions({ ...base, hand: ["1-1"], drawPileCount: 5, isViewerTurn: true }),
    { canDraw: true, canPass: false, mustPlay: false },
  );
  // Nothing fits, pile empty → pass only.
  assert.deepEqual(
    availableActions({ ...base, hand: ["1-1"], drawPileCount: 0, isViewerTurn: true }),
    { canDraw: false, canPass: true, mustPlay: false },
  );
  // Not on turn → nothing.
  assert.deepEqual(
    availableActions({ ...base, hand: ["1-1"], drawPileCount: 5, isViewerTurn: false }),
    { canDraw: false, canPass: false, mustPlay: false },
  );
});

test("dominoes ui: a stale snapshot can never roll the board back", () => {
  const live = { version: 4, status: "playing" };
  assert.equal(isIncomingSnapshotStale(live, { version: 3, status: "playing" }), true);
  assert.equal(isIncomingSnapshotStale(live, { version: 5, status: "playing" }), false);
  assert.equal(isIncomingSnapshotStale(live, { version: 4, status: "playing" }), false);
  // A resignation landing on the same version must survive a live re-read.
  assert.equal(
    isIncomingSnapshotStale({ version: 4, status: "finished" }, { version: 4, status: "playing" }),
    true,
  );
  // A malformed payload is not a newer truth.
  assert.equal(isIncomingSnapshotStale(live, { status: "playing" }), true);
  assert.equal(isIncomingSnapshotStale(null, { version: 1, status: "playing" }), false);
});

test("dominoes ui: the action log names the clock's own actions as such", () => {
  assert.equal(
    loggedActionLabel({ action: "play", tile: "6-3", chainEnd: "left" }),
    "played 6–3 on the left",
  );
  assert.equal(
    loggedActionLabel({ action: "play", tile: "6-3", chainEnd: "right" }),
    "played 6–3 on the right",
  );
  assert.equal(loggedActionLabel({ action: "draw" }), "drew a tile");
  assert.equal(loggedActionLabel({ action: "pass" }), "passed");
  assert.equal(loggedActionLabel({ action: "draw", timedOut: true }), "the clock drew a tile");
  assert.equal(loggedActionLabel({ action: "pass", timedOut: true }), "the clock passed");
  assert.equal(
    loggedActionLabel({ action: "play", tile: "0-0", chainEnd: "left", timedOut: true }),
    "the clock played 0–0 on the left",
  );
});

/* -------------------------------------------------------------------------- *
 * 6. The transport: intent only, and the existing live channel
 * -------------------------------------------------------------------------- */

test("dominoes online: the only gameplay request is an action plus a version", () => {
  assert.ok(
    pageCode.includes("JSON.stringify({ action, expectedVersion })"),
    "the move request must carry exactly the action and the version",
  );
  for (const forbidden of ["winnerId", "gameState", "hand:", "drawPile", "turn:", "result:"]) {
    assert.equal(
      new RegExp(`JSON\\.stringify\\(\\{[^}]*\\b${forbidden.replace(":", "")}\\b`).test(pageCode),
      false,
      `${forbidden} must never be sent by the match view`,
    );
  }
  // The version is read from the snapshot, never invented.
  assert.ok(pageCode.includes("const expectedVersion = current.version"));
  assert.ok(pageCode.includes('if (String(current.status) !== "playing" || !current.isViewerTurn)'));
  // The three actions are the engine's own three, and nothing else.
  assert.ok(pageCode.includes('{ type: "draw" }'));
  assert.ok(pageCode.includes('{ type: "pass" }'));
  assert.ok(pageCode.includes('{ type: "play", tile, end }'));
});

test("dominoes online: the board renders the server's snapshot and the shared outcome rule", () => {
  // The page reads these off the snapshot…
  for (const field of [
    "match?.viewerSeat",
    "match?.isLive",
    "match?.turnDeadlineAt",
    "match?.opponentTileCount",
    "match?.result",
    "match?.winnerId",
    "match?.resultReason",
  ]) {
    assert.ok(pageCode.includes(field), `the match page must read ${field}`);
  }
  // …the board renders the rest, straight from the projection.
  const board = stripComments(read("src/components/dominoes/DominoMatchView.tsx"));
  for (const field of ["snapshot.hand", "snapshot.chain", "snapshot.openEnds", "snapshot.drawPileCount"]) {
    assert.ok(board.includes(field), `the board must read ${field}`);
  }
  // Whose turn it is comes from the server's flag, not from a seat comparison.
  assert.ok(pageCode.includes("current.isViewerTurn"));
  assert.equal(/isViewerTurn\s*===\s*viewerSeat|turn\s*===\s*viewerSeat/.test(board), false);
  // The verdict is the shared, seat-based rule — and it keeps draws.
  assert.ok(pageCode.includes("outcomeFor({"));
  assert.equal(/\.winner\s*===/.test(pageCode), false);
  assert.ok(pageCode.includes("PvpResultScreen"));
  assert.ok(pageCode.includes('outcome === "draw"'));
});

test("dominoes online: the live link is the existing room relay, notifications only", () => {
  assert.ok(pageCode.includes("dominoesMatchRoom(matchId)"));
  assert.ok(pageCode.includes('socket.emit("join_room", { roomId })'));
  // Re-joining on every reconnect is what cancels the server's grace timer.
  assert.ok(pageCode.includes('socket.on("connect", join)'));
  assert.ok(pageCode.includes('socket.emit("leave_room", { roomId })'));
  assert.ok(pageCode.includes("DOMINOES_MATCH_UPDATED"));
  assert.ok(pageCode.includes("DOMINOES_READY"));
  // The notification triggers a READ; the payload is never rendered.
  assert.ok(pageCode.includes("const onUpdate = () => refresh();"));
  assert.equal(/onUpdate\s*=\s*\(?[a-z]*\)?\s*=>\s*setMatch/.test(pageCode), false);
});

test("dominoes online: no polling — one reconnect read, one deadline read", () => {
  assert.equal(/setInterval\(/.test(pageCode), false, "the match page must not poll");
  assert.equal(/useVisiblePoll|useSocketAwarePoll/.test(pageCode), false);
  assert.ok(pageCode.includes("useMatchSync(refresh, socket"));
  // The deadline read is armed on the SERVER's instant, and only while live.
  assert.ok(pageCode.includes("useDeadlineRead(isLive ? match?.turnDeadlineAt"));
  assert.ok(pageCode.includes("useTurnCountdown("));
  // …and the client never resolves the turn itself: no timer submits anything.
  assert.equal(/setTimeout\([\s\S]*submit\(/.test(pageCode), false);
});

test("dominoes online: the room vocabulary matches the realtime server exactly", () => {
  const prefixLiteral = new RegExp(
    `DOMINOES_MATCH_ROOM_PREFIX\\s*=\\s*"${DOMINOES_MATCH_ROOM_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
  );
  assert.ok(prefixLiteral.test(realtime), "the realtime server must use the same room prefix");
  assert.equal(DOMINOES_MATCH_ROOM_PREFIX, "dominoes:match:");
  assert.equal(dominoesMatchRoom("abc"), "dominoes:match:abc");
  // The generic relay event every game uses, so `room_event` routes it unchanged.
  assert.equal(DOMINOES_MATCH_UPDATED, "lobby:updated");
  assert.equal(DOMINOES_READY, "dominoes:ready");
  assert.equal(DOMINOES_LOBBY_ROOM, "lobby:dominoes");
});

test("dominoes online: disconnects resolve through the existing grace-timer path", () => {
  for (const needle of [
    "trackDominoesJoin",
    "trackDominoesLeave",
    'socket.on("dominoes:ready"',
    "dominoesRoomParticipants",
    "cancelDisconnectGraceTimer(`dominoes:${matchId}:${userId}`)",
    "scheduleDisconnectGraceTimer(`dominoes:${mid}:${socket.data.userId}`",
    "/api/dominoes/disconnect-forfeit",
    '"dominoes:rejectReady"',
  ]) {
    assert.ok(realtime.includes(needle), `the realtime server must wire ${needle}`);
  }
  // The poke is participant-gated, and the forfeit call re-verifies the token.
  assert.ok(realtime.includes("!participants.has(socket.data.userId)"));
  assert.ok(read("src/app/api/dominoes/disconnect-forfeit/route.ts").includes("verifyToken"));
});

test("dominoes online: a broadcast is a hint, and never carries a position", () => {
  // The helper is a no-op without a live io instance (split deployment).
  assert.equal(
    broadcastMatchUpdate("11111111-1111-4111-8111-111111111111", { status: "playing" }),
    false,
  );
  // No route pushes a hand, a pile or a chain.
  const routes = [
    "src/app/api/dominoes/create-or-join/route.ts",
    "src/app/api/dominoes/match/[matchId]/route.ts",
    "src/app/api/dominoes/match/[matchId]/move/route.ts",
    "src/app/api/dominoes/match/[matchId]/forfeit/route.ts",
    "src/app/api/dominoes/match/[matchId]/cancel/route.ts",
    "src/app/api/dominoes/disconnect-forfeit/route.ts",
  ];
  for (const route of routes) {
    const source = read(route);
    const calls = [...source.matchAll(/broadcastMatchUpdate\(([\s\S]*?)\);/g)]
      .map((match) => match[1])
      .join("\n");
    assert.doesNotMatch(
      calls,
      /\b(hand|p1Hand|p2Hand|drawPile|chain|openEnds|gameState)\b/,
      `${route} must not broadcast a position`,
    );
  }
});

/* -------------------------------------------------------------------------- *
 * 7. Lobby, routes, middleware
 * -------------------------------------------------------------------------- */

test("dominoes online: the lobby creates, joins and cancels — and stays unstaked", () => {
  assert.ok(lobbyCode.includes('fetch("/api/dominoes/create-or-join"'));
  assert.ok(lobbyCode.includes('fetch("/api/dominoes/available"'));
  assert.ok(lobbyCode.includes("/cancel`"));
  assert.ok(lobbyCode.includes('headers: { "Content-Type": "application/json" }'));
  // No stake picker, no wager in the body: Dominoes is free. (The rules copy
  // mentions "there is no stake" in prose, so this checks the CODE: no wager prop
  // and no stake field in any request.)
  assert.equal(/wager=/.test(lobbyCode), false);
  assert.equal(/JSON\.stringify\(\{[^}]*\bstake\b/.test(lobbyCode), false);
  assert.ok(lobbyCode.includes("canPlay={Boolean(isSignedIn)}"));
  assert.ok(lobbyCode.includes("onResume"));
  // The open-lobby list is polled socket-aware and gated on the account.
  assert.ok(lobbyCode.includes("useSocketAwarePoll(fetchLobbies, socket, Boolean(isSignedIn))"));
  assert.ok(lobbyCode.includes("if (isSignedIn === false) setLobbiesLoading(false);"));
});

test("dominoes online: Find a Match waits on the matchmaking screen", () => {
  assert.ok(lobbyCode.includes("if (data.data?.joined)"));
  assert.ok(lobbyCode.includes("setWaitingMatchId(String(data.data.matchId))"));
  assert.ok(lobbyCode.includes("<MatchWaiting"));
  assert.ok(lobbyCode.includes("MATCH_STATUS.PLAYING"));
  assert.ok(lobbyCode.includes("`/api/dominoes/match/${waitingMatchId}`"));
  assert.ok(lobbyCode.includes("onResume={(id: string) => setWaitingMatchId(id)}"));

  // Exactly one navigation, inside the `joined` branch.
  const handler = lobbyCode.slice(
    lobbyCode.indexOf("const createOrJoin = useCallback"),
    lobbyCode.indexOf("const cancelLobby"),
  );
  assert.equal((handler.match(/router\.push\(/g) ?? []).length, 1);
  assert.ok(handler.indexOf("if (data.data?.joined)") < handler.indexOf("router.push("));
});

test("dominoes online: the lobby and match URLs are the ones that resolve", () => {
  // Bare /casino/dominoes 308-redirects to /games/dominoes, which is the
  // PUBLIC LANDING page (src/lib/gameLandingPages.ts), so the lobby must be
  // addressed at /games/dominoes/play, which next.config.js rewrites to
  // /casino/dominoes.
  assert.ok(page.includes('const LOBBY_PATH = "/games/dominoes/play"'));
  assert.ok(lobbyCode.includes("`/games/dominoes/${id}`"));
  assert.equal(/push\("\/casino\/dominoes"\)/.test(lobbyCode + pageCode), false);
  // The middleware classifies the whole subtree as a game route, or a signed-out
  // visitor is bounced to /sign-in instead of seeing the lobby.
  assert.ok(proxy.includes('"/casino/dominoes(.*)"'));
  assert.ok(proxy.includes('"/games/dominoes(.*)"'));
  // Both application pages are noindex: the indexable page for the game is the
  // public landing page at /games/dominoes, not the lobby or a live match.
  for (const route of [LOBBY_ROUTE, MATCH_ROUTE]) {
    assert.ok(read(route).includes("index: false"), `${route} must be noindex`);
  }
});

/* -------------------------------------------------------------------------- *
 * 8. Responsive + reduced motion (the CSS contract)
 * -------------------------------------------------------------------------- */

test("dominoes css: the chain grows as one line and the board scrolls along it", () => {
  const chain = css.slice(css.indexOf(".dominoes-chain {"), css.indexOf(".dominoes-chain-slot"));
  // A real table does not reflow a line of dominoes into a block of rows: the
  // row stays a row, keeps its size and extends in both directions.
  assert.match(chain, /flex-wrap:\s*nowrap/);
  assert.match(chain, /overflow-x:\s*auto/);
  assert.equal(/max-height:\s*min\(34vh/.test(chain), false, "the line is no longer boxed in");
  assert.match(chain, /min-height:\s*clamp\(/, "the board has a table-sized floor");
  // Tile size is one variable, clamped so a phone still shows readable halves —
  // and it is bigger than the first board shipped with.
  const board = css.slice(css.indexOf(".dominoes-board {"), css.indexOf(".dominoes-layout {"));
  assert.match(board, /--dm-half:\s*clamp\(24px,/);
  // The hand scales itself up from the same variable.
  assert.match(css, /\.dominoes-hand \{[\s\S]*?--dm-half:\s*clamp\(/);
});

test("dominoes css: the controls sit in a right-hand sidebar, the hand under the board", () => {
  // Two columns: board first, controls second.
  const layout = css.slice(css.indexOf(".dominoes-layout {"), css.indexOf(".dominoes-seat {"));
  assert.match(layout, /grid-template-columns:\s*minmax\(0, 1fr\) 264px/);
  // …and it stacks on a phone, so the sidebar never squeezes the board.
  assert.match(layout, /@media \(max-width: 900px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  // The board and the hand are one column, so the tiles stay under the table.
  const main = css.slice(css.indexOf(".dominoes-main {"), css.indexOf(".dominoes-sidebar {"));
  assert.match(main, /flex-direction:\s*column/);
});

test("dominoes css: tap targets, small screens and reduced motion", () => {
  // Every actionable control is at least 44px tall and ignores double-tap zoom.
  const action = css.slice(css.indexOf(".dominoes-action-button {"), css.indexOf(".dominoes-action-value"));
  const height = Number(/min-height:\s*(\d+)px/.exec(action)?.[1] ?? 0);
  assert.ok(height >= 44, `the action target is ${height}px tall, below the 44px minimum`);
  assert.match(action, /touch-action:\s*manipulation/);
  // A narrow-phone block exists, and it lets the end buttons take a full row each.
  assert.match(css, /@media \(max-width: 420px\) \{/);
  assert.match(css, /\.dominoes-action-button \{\s*flex-basis: 100%;/);
  // Reduced motion removes the placement animation AND the lift on selection.
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.dominoes-tile\.is-new \{\s*animation: none;/);
  assert.match(reduced, /button\.dominoes-tile\.is-selected \{\s*transform: none;/);
});
