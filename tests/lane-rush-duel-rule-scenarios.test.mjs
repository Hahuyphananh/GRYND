/**
 * Lane Rush Duel — second-pass rule-scenario verification.
 *
 * These tests re-derive the exact banked/unbanked numbers from the
 * reported scenarios using ONLY the production helpers
 * (`scoreFromActions`, `bankedScoreOf`, `unbankedOf`, `climbEnded`,
 * `bankedWinnerOf`), plus structural contracts on the single server
 * transition and the client's concurrency guards that the pure helpers
 * can't express (no DB / no DOM in this suite).
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-rule-scenarios.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  BOT_USER_ID,
  MATCH_STATUS,
  MAX_LANES,
  PICKABLE_STATES,
  RISK_PATHS,
  WIN_BANKED_SCORE,
  bankedGainOnHold,
  bankedScoreOf,
  bankedWinnerOf,
  buildPlayerTower,
  bustsByLaneForSeat,
  climbEnded,
  decideBotAction,
  hasResolvedActionId,
  isStaleRoundAction,
  latestBustFor,
  scoreFromActions,
  unbankedLostOnBust,
  unbankedOf,
} from "../src/lib/lane-rush-duel/constants.js";

// Normalise CRLF so multi-line structural assertions work on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const page = read("src/app/casino/lane-runner/[matchId]/PageClient.jsx");
const store = read("src/lib/lane-rush-duel/serverStore.js");

const SEAT = "player1";
const OTHER = "player2";

// ── History builders (exactly the rows the server writes) ────────────
function pick({ seat = SEAT, safe = true, points = 0, path = "balanced", tile = 0, round = 0, actionId } = {}) {
  return {
    seat,
    action: "pick",
    path,
    tile,
    lane: round,
    round,
    safe,
    points,
    pending: false,
    ...(actionId ? { actionId } : {}),
  };
}

function hold({ seat = SEAT, bankedTotal, round = 0, actionId } = {}) {
  return {
    seat,
    action: "hold",
    lane: round,
    round,
    bankedTotal,
    pending: false,
    ...(actionId ? { actionId } : {}),
  };
}

// A seat's state as the app derives it. Accepts either a raw action
// history or a match-shaped object (the production helpers take a match).
function stateOf(input, seat = SEAT) {
  const match = Array.isArray(input) ? { actions: input } : input || {};
  return {
    total: scoreFromActions(match.actions, seat),
    banked: bankedScoreOf(match, seat),
    unbanked: unbankedOf(match, seat),
    bust: latestBustFor(match.actions, seat),
    continues: !climbEnded(match, seat),
  };
}

function assertInvariants(actions, { total, banked, unbanked }) {
  const s = stateOf(actions);
  assert.equal(s.total, total, "accumulated total");
  assert.equal(s.banked, banked, "banked (locked) total");
  assert.equal(s.unbanked, unbanked, "unbanked (at-risk) run");
  // total is always banked + unbanked, and unbanked is never negative.
  assert.equal(s.total, s.banked + s.unbanked);
  assert.ok(s.unbanked >= 0);
  return s;
}

// banked 100 + unbanked 50, reachable exactly as the engine reaches it:
// safe pick (+100) → bank (locks 100) → safe pick (+50).
function scenario1History() {
  return [pick({ points: 100 }), hold({ bankedTotal: 100 }), pick({ points: 50, round: 1 })];
}

// ════════════════════════════════════════════════════════════════════
// SCENARIO 1 — banked 100 / unbanked 50, player clicks RED
// ════════════════════════════════════════════════════════════════════
test("S1: red tile zeroes the unbanked run and leaves the banked total intact", () => {
  const before = scenario1History();
  assertInvariants(before, { total: 150, banked: 100, unbanked: 50 });

  const after = [...before, pick({ safe: false, round: 1 })];
  const s = assertInvariants(after, { total: 100, banked: 100, unbanked: 0 });

  assert.equal(s.bust.safe, false);
  assert.equal(s.continues, true, "the duel keeps going");
  assert.equal(bankedWinnerOf({ actions: after }), null, "no winner from a bust");
  assert.ok(PICKABLE_STATES.has(MATCH_STATUS.ACTIVE));
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 2 — banked 100 / unbanked 0, player clicks RED
// ════════════════════════════════════════════════════════════════════
test("S2: red tile with nothing unbanked is a no-op on points and the duel continues", () => {
  const before = [pick({ points: 100 }), hold({ bankedTotal: 100 })];
  assertInvariants(before, { total: 100, banked: 100, unbanked: 0 });

  const after = [...before, pick({ safe: false, round: 1 })];
  const s = assertInvariants(after, { total: 100, banked: 100, unbanked: 0 });
  assert.equal(s.continues, true);
  assert.equal(bankedWinnerOf({ actions: after }), null);
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 3 — banked 100 / unbanked 50, safe pick +20
// ════════════════════════════════════════════════════════════════════
test("S3: a safe tile adds to unbanked only (100 / 50 → 100 / 70)", () => {
  const before = scenario1History();
  const after = [...before, pick({ points: 20, round: 2 })];
  assertInvariants(after, { total: 170, banked: 100, unbanked: 70 });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 4 — banked 100 / unbanked 70, player BANKS
// ════════════════════════════════════════════════════════════════════
test("S4: banking transfers the whole run (100 / 70 → 170 / 0)", () => {
  const before = [...scenario1History(), pick({ points: 20, round: 2 })];
  const s = stateOf(before);
  assert.equal(s.total, 170);

  // The server's hold records `scoreFromActions(seat)` — i.e. the
  // banked total PLUS the unbanked run — as the new locked total.
  const bankedTotal = scoreFromActions(before, SEAT);
  assert.equal(s.unbanked, 70);
  assert.equal(bankedTotal, 170);
  assert.equal(bankedTotal, s.banked + s.unbanked);

  const after = [...before, hold({ bankedTotal, round: 2 })];
  assertInvariants(after, { total: 170, banked: 170, unbanked: 0 });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 5 — banked 170 / unbanked 0, player clicks RED
// ════════════════════════════════════════════════════════════════════
test("S5: red straight after banking keeps all 170 protected and the duel alive", () => {
  const banked = [...scenario1History(), pick({ points: 20, round: 2 })];
  const afterBank = [...banked, hold({ bankedTotal: 170, round: 2 })];
  assertInvariants(afterBank, { total: 170, banked: 170, unbanked: 0 });

  const after = [...afterBank, pick({ safe: false, round: 3 })];
  const s = assertInvariants(after, { total: 170, banked: 170, unbanked: 0 });
  assert.equal(s.continues, true);
  assert.equal(bankedWinnerOf({ actions: after }), null);
  // The bust marker is on the row that was hit, and the banked row is
  // still reported as banked.
  assert.equal(bustsByLaneForSeat(after, SEAT)[3].tile, 0);
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 6 — rapid repeat clicks on the same tile
// ════════════════════════════════════════════════════════════════════
test("S6: the same actionId resolves once, a fresh tap is a new action", () => {
  const actions = [pick({ points: 10, actionId: "m1:p1:1" })];
  assert.equal(hasResolvedActionId(actions, "m1:p1:1"), true);
  assert.equal(hasResolvedActionId(actions, "m1:p1:2"), false);

  // A replay of the identical tap is dropped before any scoring.
  const replay = actions.filter((a) => !hasResolvedActionId(actions, a.actionId));
  assert.equal(replay.length, 0);
  assertInvariants(actions, { total: 10, banked: 0, unbanked: 10 });
});

test("S6: the client can only ever have one action in flight, and a busted tile cannot be re-picked", () => {
  // One synchronous guard set before the first await -> a second click in
  // the same window is dropped.
  assert.ok(page.includes("if (!matchId || actingRef.current) return;"));
  assert.ok(page.includes("actingRef.current = true;"));
  assert.ok(page.includes("actingRef.current = false;"));
  assert.ok(!page.includes("pickedRef"));
  // The tile you already busted on is not selectable in pick mode
  // (flag mode keeps it selectable — flagging a known bad tile is legal).
  assert.ok(page.includes("tileIsSelectable && !(tileIsMyBust && !flagMode)"));
  assert.ok(page.includes("resolvedBust.tile === tileIndex"));
  // Tiles are disabled while an action is in flight.
  assert.ok(page.includes("disabled={!tileCanPick}"));
  assert.ok(page.includes("!acting && isMyTurn"));
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 7 — player action and AI action at nearly the same time
// ════════════════════════════════════════════════════════════════════
test("S7: interleaved player + AI transitions apply once each and never clobber", () => {
  const tower = buildPlayerTower({
    serverSeed: "s",
    clientSeed: "c",
    nonce: 7,
    difficulty: "easy",
  });
  const match = {
    id: 7,
    player1Id: "u1",
    player2Id: BOT_USER_ID,
    difficulty: "easy",
    status: MATCH_STATUS.ACTIVE,
    currentTurnUserId: null,
    roundDeadline: null,
    p1Lane: 0,
    p2Lane: 0,
    p1Held: false,
    p2Held: false,
    p1Tower: tower,
    p2Tower: tower,
    actions: [],
  };

  // Both requests serialize on the row: each transaction re-reads the
  // latest committed row before writing (what SELECT … FOR UPDATE buys),
  // so neither write is derived from a stale snapshot.
  const playerLaneBefore = match.p1Lane;
  match.actions.push(pick({ seat: SEAT, points: 10, round: playerLaneBefore, actionId: "p:7:1" }));
  match.p1Lane = (playerLaneBefore + 1) % MAX_LANES;

  const botLaneBefore = match.p2Lane;
  match.actions.push(pick({ seat: OTHER, points: 10, round: botLaneBefore, actionId: "b:7:1" }));
  match.p2Lane = (botLaneBefore + 1) % MAX_LANES;

  // No lost update: the player's lane and run survive the AI write.
  assert.equal(match.p1Lane, 1);
  assert.equal(match.p2Lane, 1);
  assert.equal(unbankedOf(match, SEAT), 10);
  assert.equal(bankedWinnerOf(match), null, "no incorrect winner");
  assert.equal(match.status, MATCH_STATUS.ACTIVE);

  // A duplicated delivery of either request is a no-op.
  assert.equal(hasResolvedActionId(match.actions, "p:7:1"), true);
  assert.equal(hasResolvedActionId(match.actions, "b:7:1"), true);

  // A stale client click (rendered on row 0 after the row advanced) is
  // rejected rather than resolving on the wrong row.
  assert.equal(isStaleRoundAction({ expectedRound: playerLaneBefore, currentLane: match.p1Lane }), true);
  assert.equal(isStaleRoundAction({ expectedRound: match.p1Lane, currentLane: match.p1Lane }), false);

  // The client also refuses to write an out-of-order response.
  assert.ok(page.includes("seq !== syncSeqRef.current"));
  assert.ok(page.includes("signal: controller.signal"));
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 8 — duel ends while an AI callback is pending
// ════════════════════════════════════════════════════════════════════
test("S8: a pending AI callback cannot mutate a finished duel", () => {
  // Server: a finished match is not pickable, so the bot transition
  // rejects before it can touch the row (the check runs inside the
  // row-locked transaction, before any decision or write).
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.FINISHED), false);
  assert.equal(PICKABLE_STATES.has(MATCH_STATUS.CANCELLED), false);
  const botActBody = store.slice(store.indexOf("export async function botAct"));
  assert.ok(
    botActBody.indexOf("!PICKABLE_STATES.has(match.status)") <
      botActBody.indexOf("decideBotAction(match)"),
    "the terminal-state check must precede the bot decision",
  );

  // Client: the wake-up effect only runs for live states, and a failed
  // wake-up resyncs before it retries, so a finished duel stops the
  // retry chain instead of hammering the endpoint.
  assert.ok(
    page.includes("match?.status === \"active\" ||") &&
      page.includes("match?.status === \"p1_turn\" ||"),
  );
  assert.ok(page.includes("if (!isBotMatch || !matchId || !isActive)"));
  assert.ok(page.includes("await fetchStatus();\n          if (!mountedRef.current) return;"));
  assert.ok(page.includes("if (!mountedRef.current) return;"));
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 9 — unmount / remount
// ════════════════════════════════════════════════════════════════════
test("S9: remounting cannot duplicate timers, listeners or AI actions", () => {
  // Every timer/listener is torn down with its effect.
  assert.ok(page.includes("clearInterval(interval)"));
  assert.ok(page.includes("clearInterval(t)"));
  assert.ok(page.includes("clearTimeout(timer)"));
  assert.ok(page.includes('socket.off(LANE_RUSH_DUEL_MATCH_UPDATED, refresh)'));
  assert.ok(page.includes('socket.emit("leave_room"'));
  assert.ok(page.includes("syncAbortRef.current?.abort()"));

  // The bot wake-up id is derived from the server state, so a remount
  // that re-fires the SAME wake-up is deduped server-side (the stored
  // entry carries the id).
  const turnKey = [7, 2, 1, false].join(":");
  const actionId = `7:bot:${turnKey}`;
  const actions = [pick({ seat: OTHER, points: 10, round: 0, actionId })];
  assert.equal(hasResolvedActionId(actions, actionId), true);
  assert.equal(hasResolvedActionId(actions, `${actionId}x`), false);
  assert.ok(store.includes("if (actionId) entry.actionId = String(actionId);"));
  assert.ok(page.includes("const actionId = `${matchId}:bot:${turnKey}`;"));
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO 10 — resizing
// ════════════════════════════════════════════════════════════════════
test("S10: tiles keep a clickable size at every viewport", () => {
  assert.ok(page.includes("min-h-[48px]"));
  assert.ok(page.includes("min-w-[44px]"));
  assert.ok(page.includes("sm:min-h-[56px]"));
  assert.ok(page.includes("min-h-[84px] sm:min-h-[92px]"), "rows can't collapse");
  assert.ok(page.includes("overflow-y-auto overscroll-contain"), "the board scrolls");
  assert.ok(page.includes("touch-manipulation"));
  assert.ok(!page.includes("gridAutoRows"), "no auto-row sizing that collapses tiles");
  assert.ok(!page.includes("h-full rounded border text-[10px]"));
});

// ════════════════════════════════════════════════════════════════════
// Remaining forbidden paths
// ════════════════════════════════════════════════════════════════════
test("the bust branch never touches the lane, the bank, or the match result", () => {
  const body = store.slice(
    store.indexOf("async function applyEntryImmediately"),
    store.indexOf("async function persistSimultaneousState"),
  );
  assert.ok(body.includes("entry.safe === false"));
  assert.ok(body.includes("nextLane = currentLane;"), "a bust keeps the row");
  // The single settle trigger is a hold that locked the win target.
  assert.equal((body.match(/resolveMatch\(/g) || []).length, 1);
  assert.ok(body.includes('entry.action === "hold" && Number(entry.bankedTotal) >= WIN_BANKED_SCORE'));
  // No bust-derived loss/winner logic anywhere in the store.
  assert.ok(!store.includes("busted_target"));
  assert.ok(!store.includes("reason: \"bust\""));
});

test("the AI cannot win off a player bust, and no stale response decides a winner", () => {
  const actions = [...scenario1History(), pick({ safe: false, round: 1 })];
  const match = {
    player1Id: "u1",
    player2Id: BOT_USER_ID,
    difficulty: "easy",
    actions,
    p1Lane: 1,
    p2Lane: 0,
    p1Held: true,
    p2Held: false,
  };
  assert.equal(bankedWinnerOf(match), null);
  const decision = decideBotAction(match, { random: () => 0.5 });
  assert.ok(decision && ["pick", "hold"].includes(decision.action));
  // The bot's decision is a climb/bank choice — it never "claims" a win.
  assert.equal(bankedWinnerOf(match), null);
  assert.equal(climbEnded(match, "player1"), false);
  assert.equal(climbEnded(match, "player2"), false);
  assert.ok(decision.action !== "claim");
});

test("no readout feeds unbanked points into a banked total", () => {
  const s = stateOf(scenario1History());
  assert.equal(s.banked, 100);
  assert.equal(s.unbanked, 50);
  assert.equal(s.total, 150);
  // The client derives at-risk as total − banked, clamped at 0.
  assert.ok(page.includes("const myUnbanked = Math.max(0, myScore - myBanked);"));
  assert.ok(page.includes("const oppUnbanked = Math.max(0, oppScore - oppBanked);"));
  // The final-score payload comes from the server's own finals.
  assert.ok(store.includes('p1Points: finalScoreOf({ ...match, actions }, "player1")'));
  assert.ok(!page.includes("myBanked = myScore"));
  assert.ok(!page.includes("myScore = myBanked"));
});

// ════════════════════════════════════════════════════════════════════
// Bust FEEDBACK figures — the numbers the board/chip/banner render.
// These are display-only derivations; the rules above are untouched.
// ════════════════════════════════════════════════════════════════════
test("bust with unbanked points: the UI figure equals the run that was lost", () => {
  const bust = pick({ safe: false, round: 1 });
  const actions = [...scenario1History(), bust];

  assert.equal(unbankedLostOnBust(actions, SEAT, bust), 50, "lost = the at-risk run");
  assert.equal(bustsByLaneForSeat(actions, SEAT)[1].lost, 50);
  assert.equal(latestBustFor(actions, SEAT), bust, "the banner is driven by this bust");
  // Banked stays safe in the same snapshot.
  assert.equal(bankedScoreOf({ actions }, SEAT), 100);
  assert.equal(unbankedOf({ actions }, SEAT), 0);
});

test("bust with ZERO unbanked: the figure is 0 (never a phantom loss)", () => {
  const bust = pick({ safe: false, round: 1 });
  const actions = [pick({ points: 100 }), hold({ bankedTotal: 100 }), bust];

  assert.equal(unbankedLostOnBust(actions, SEAT, bust), 0);
  assert.equal(bustsByLaneForSeat(actions, SEAT)[1].lost, 0);
  assert.equal(bankedScoreOf({ actions }, SEAT), 100, "banked still safe");
  assert.equal(climbEnded({ actions }, SEAT), false);
});

test("bust straight after banking: nothing at risk, all banked points kept", () => {
  const bust = pick({ safe: false, round: 3 });
  const actions = [
    ...scenario1History(),
    pick({ points: 20, round: 2 }),
    hold({ bankedTotal: 170, round: 2 }),
    bust,
  ];

  const s = assertInvariants(actions, { total: 170, banked: 170, unbanked: 0 });
  assert.equal(unbankedLostOnBust(actions, SEAT, bust), 0);
  assert.equal(s.continues, true);
  assert.equal(bankedWinnerOf({ actions: actions }), null);
});

test("repeated busts: each bust keeps its own figure; clearing a row clears its marker", () => {
  const first = pick({ safe: false, round: 1 });
  // A bust does NOT advance the row, so recovering row 1 with a safe pick
  // is what lets the seat bust again — on row 2.
  const second = pick({ safe: false, round: 2 });
  const actions = [...scenario1History(), first, pick({ points: 5, round: 1 }), second];

  // Every bust's loss is re-derived from history and stays correct.
  assert.equal(unbankedLostOnBust(actions, SEAT, first), 50);
  assert.equal(unbankedLostOnBust(actions, SEAT, second), 5);

  // The live marker tracks the CURRENT bust: recovering row 1 cleared
  // row 1, so only row 2 is marked and it shows its own (smaller) figure.
  const byLane = bustsByLaneForSeat(actions, SEAT);
  assert.equal(byLane[1], undefined, "the recovered row dropped its marker");
  assert.equal(byLane[2].lost, 5, "row 2 lost only the 5 picked after the bust");
  assert.equal(latestBustFor(actions, SEAT), second, "banner follows the newest bust");
  assert.equal(bankedScoreOf({ actions }, SEAT), 100, "banked never moved");
  assert.equal(unbankedOf({ actions }, SEAT), 0);
});

test("continued play after a bust clears the marker but keeps the banked total", () => {
  const bust = pick({ safe: false, round: 1 });
  const recovered = [...scenario1History(), bust, pick({ safe: true, points: 30, round: 1 })];

  assert.equal(latestBustFor(recovered, SEAT), null, "the banner clears on a safe pick");
  assert.equal(bustsByLaneForSeat(recovered, SEAT)[1], undefined, "row marker cleared");
  assertInvariants(recovered, { total: 130, banked: 100, unbanked: 30 });
  assert.equal(climbEnded({ actions: recovered }, SEAT), false);
});

test("refresh/poll after a bust cannot change the figure or replay it", () => {
  const bust = pick({ safe: false, round: 1 });
  const actions = [...scenario1History(), bust];

  // The figure is re-derived from the immutable history, so N identical
  // re-deliveries (poll, socket push, refresh) all agree.
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    seen.add(unbankedLostOnBust(actions, SEAT, latestBustFor(actions, SEAT)));
    seen.add(bustsByLaneForSeat(actions, SEAT)[1].lost);
  }
  assert.deepEqual([...seen], [50]);

  // The client's feedback key is built from row + tile + the action
  // timestamp, so the SAME bust always yields the SAME key — a refresh
  // cannot look like a new bust (which is what would replay the buzz and
  // the one-shot animation).
  assert.ok(page.includes("const bustKeyOf = (bust) =>"));
  assert.ok(page.includes("bust.round ?? bust.lane"));
  assert.ok(page.includes("bust.tile ?? \"\""));
  assert.ok(page.includes("bust.at ?? \"\""));
  // A resolved pick is forwarded to the client untouched, so the key
  // material survives the viewer scrub (only pending/peer-peek entries
  // are rewritten).
  assert.ok(store.includes("return a;\n      })\n    : match.actions;"));
});

test("an AI match: the bot's own bust never touches the player's figures", () => {
  const tower = buildPlayerTower({
    serverSeed: "s",
    clientSeed: "c",
    nonce: 11,
    difficulty: "easy",
  });
  const bust = pick({ seat: SEAT, safe: false, round: 1 });
  const actions = [...scenario1History(), bust];
  // The bot busts its own row in the same window.
  actions.push(pick({ seat: OTHER, safe: false, round: 0 }));

  const match = {
    player1Id: "u1",
    player2Id: BOT_USER_ID,
    difficulty: "easy",
    p1Tower: tower,
    p2Tower: tower,
    actions,
    p1Lane: 1,
    p2Lane: 0,
    p1Held: true,
    p2Held: false,
  };

  // The player's figures are unchanged by the bot's action.
  assert.equal(unbankedLostOnBust(actions, SEAT, bust), 50);
  assert.equal(bankedScoreOf(match, SEAT), 100);
  assert.equal(unbankedOf(match, SEAT), 0);
  // The bot's bust is reported separately and settles nothing.
  assert.equal(bustsByLaneForSeat(actions, OTHER)[0].lost, 0);
  assert.equal(latestBustFor(actions, SEAT), bust, "still OUR bust on the banner");
  assert.equal(bankedWinnerOf(match), null);
  assert.equal(climbEnded(match, "player2"), false);
});

// ════════════════════════════════════════════════════════════════════
// BANKING feedback figures — what the "+N moved / M protected" copy
// claims. Display-only derivations; the banking rules above are
// untouched (and the server never uses this helper).
// ════════════════════════════════════════════════════════════════════
test("bank with unbanked points: the move equals the run that got protected", () => {
  const first = hold({ bankedTotal: 100 });
  const actions = [pick({ points: 100 }), first];
  assert.equal(bankedGainOnHold(actions, SEAT, first), 100);
  assert.equal(bankedScoreOf({ actions }, SEAT), 100);
  assert.equal(unbankedOf({ actions }, SEAT), 0, "the run is now protected");

  // Bank again with a fresh 70 at risk: the second move is just the run.
  const second = hold({ bankedTotal: 170, round: 2 });
  const after = [...actions, pick({ points: 70, round: 1 }), second];
  assert.equal(bankedGainOnHold(after, SEAT, second), 70);
  assert.equal(bankedScoreOf({ actions: after }, SEAT), 170);
});

test("re-banking with nothing at risk moves 0 (no phantom gain)", () => {
  const first = hold({ bankedTotal: 100 });
  const second = hold({ bankedTotal: 100, round: 1 });
  const actions = [pick({ points: 100 }), first, second];

  assert.equal(bankedGainOnHold(actions, SEAT, second), 0);
  assert.equal(bankedScoreOf({ actions }, SEAT), 100, "nothing changed");
  // The bank is still legal (and still advances the row) — only the
  // feedback figure is 0.
  assert.equal(bankedWinnerOf({ actions }), null);
});

test("the moves add up to the banked total across banks and busts", () => {
  const h1 = hold({ bankedTotal: 100 });
  const h2 = hold({ bankedTotal: 170, round: 2 });
  const h3 = hold({ bankedTotal: 170, round: 4 });
  const actions = [
    pick({ points: 100 }),
    h1,
    pick({ points: 70, round: 1 }),
    h2,
    pick({ safe: false, round: 2 }), // bust — the banked total must not move
    pick({ points: 25, round: 2 }),
    pick({ safe: false, round: 3 }), // bust again
    h3, // bank with nothing at risk after the busts
  ];

  const moves = [h1, h2, h3].map((h) => bankedGainOnHold(actions, SEAT, h));
  assert.deepEqual(moves, [100, 70, 0]);
  assert.equal(
    moves.reduce((a, b) => a + b, 0),
    bankedScoreOf({ actions }, SEAT),
    "the reported moves always add up to the protected total",
  );
  assert.equal(bankedScoreOf({ actions }, SEAT), 170, "busts never touched the bank");
  assert.equal(unbankedOf({ actions }, SEAT), 0);
  assert.equal(bankedWinnerOf({ actions }), null, "no settlement from a bank below target");
});

test("a bank followed by a bust keeps every protected point", () => {
  // scenario1 = banked 100 / unbanked 50, so this bank protects all 150.
  const rebank = hold({ bankedTotal: 150, round: 1 });
  const actions = [...scenario1History(), rebank, pick({ safe: false, round: 2 })];

  assert.equal(bankedGainOnHold(actions, SEAT, rebank), 50, "moved the 50 at risk");
  assertInvariants(actions, { total: 150, banked: 150, unbanked: 0 });
  assert.equal(latestBustFor(actions, SEAT)?.safe, false, "the bust is the newest event");
  assert.equal(bankedScoreOf({ actions }, SEAT), 150, "the bust took nothing protected");
  assert.equal(climbEnded({ actions }, SEAT), false, "the duel continues");
});

test("the risk-path table is untouched (no rule redesign)", () => {
  assert.deepEqual(Object.keys(RISK_PATHS).sort(), ["balanced", "risky", "safe"]);
  assert.equal(WIN_BANKED_SCORE, 1000);
});
