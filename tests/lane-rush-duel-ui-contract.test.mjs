/**
 * Lane Rush — UI + server contract tests.
 *
 * The MATCH PAGE is now the oval race, so the client assertions below pin the
 * racing contract: the plan API, the lock-in control, the fleet panel, the
 * server-only result playback, and the complete removal of the bridge
 * presentation from the active gameplay UI.
 *
 * The server half still covers the PRESERVED legacy glass-bridge store: an
 * unfinished legacy row must keep playing by its original rules even though
 * new matches never render it. Those contracts stay valid and untouched.
 *
 * Historically these locked in the contracts the pure bridge engine can't
 * express:
 *   * the client reconciles only the newest status response, retries an
 *     action once (safe because the server dedupes on `actionId`), cleans
 *     up its timers/listeners and never offers a removed mechanic;
 *   * the server has ONE authoritative transition: current-player gating,
 *     row staleness, idempotent replay rejection, and no `pending` path;
 *   * only crossing row 10 (or a resignation) settles the match;
 *   * the 15s decision window is server-authoritative on both read and
 *     write paths;
 *   * memory flags are validated against the seat's own landing, public,
 *     append-only and capped at 2 per match;
 *   * broken tiles are pushed to both seats without leaking the layout;
 *   * the legacy points / banking / multiplier / peek logic is gone.
 *
 * The pure engine itself is covered by tests/lane-rush-bridge.test.mjs.
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Normalise CRLF so multi-line structural assertions work on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const page = read("src/app/casino/lane-runner/[matchId]/PageClient.jsx");
const matchPage = read("src/app/casino/lane-runner/[matchId]/page.jsx");
const oval = read("src/components/lane-rush/OvalTrack.jsx");
const ovalMath = read("src/components/lane-rush/ovalGeometry.js");
const garage = read("src/components/lane-rush/RaceGarage.jsx");
const carSprite = read("src/components/lane-rush/CarSprite.jsx");
const carSpriteData = read("src/components/lane-rush/carSprites.js");
const store = read("src/lib/lane-rush-duel/serverStore.js");
const actRoute = read("src/app/api/lane-rush-duel/match/[matchId]/act/route.js");
const matchRoute = read("src/app/api/lane-rush-duel/match/[matchId]/route.js");
const audio = read("src/lib/gameAudio.ts");
const constants = read("src/lib/lane-rush-duel/constants.js");
const aiRoute = read("src/app/api/lane-rush-duel/match/[matchId]/ai-turn/route.js");

// ════════════════════════════════════════════════════════════════════
// Client: shared-bridge integration + state-sync safety
// ════════════════════════════════════════════════════════════════════

test("the match page is the race: it reads the racing view and never a bridge field", () => {
  assert.ok(page.includes("match?.lifecycle"), "the phase comes from the server");
  assert.ok(page.includes("match?.myCars"), "the garage comes from the server");
  assert.ok(page.includes("match?.myResources"), "the economy comes from the server");
  assert.ok(page.includes("match?.planningDeadline"), "the deadline comes from the server");
  assert.ok(page.includes("lastResult"), "the resolved round comes from the server");
  // The retired bridge presentation is gone from the active gameplay UI.
  for (const dead of [
    "isViewerTurn",
    "bridgeRows",
    "myRow",
    "oppRow",
    "myFlags",
    "oppFlags",
    "brokenSet",
    "flaggableSet",
    "flagMode",
    "JumpOverlay",
    "GlassBreak",
    "pendingBreakKey",
    "doAction(\"jump\"",
    "doAction(\"flag\"",
  ]) {
    assert.ok(!page.includes(dead), `the bridge mechanic "${dead}" must be gone`);
  }
  // A preserved legacy row is not rendered as a race board either: it gets an
  // explicit notice instead of racing controls over a bridge payload.
  assert.ok(page.includes('const legacyMatch = Boolean(match && match.mode !== "race")'));
  assert.ok(page.includes("This match used the retired bridge board"));
  assert.ok(!page.includes("bridgeRows"), "the bridge fields are never read");
  // …and the bridge-era route/page identity is preserved.
  assert.ok(page.includes('/api/lane-rush-duel/match/'), "the match routes stay");
  assert.ok(page.includes('currentPath="/casino/lane-runner"'), "the route is unchanged");
  assert.ok(matchPage.includes("Lane Rush Match #"), "metadata names the race");
  assert.ok(!matchPage.includes("10-row bridge"), "metadata no longer describes the bridge");
});

test("planning submits validated engine actions through the idempotent plan API", () => {
  assert.ok(page.includes("/api/lane-rush-duel/match/${matchId}/act"));
  for (const field of ["actionId", "round:", "stateVersion:", "actions,"]) {
    assert.ok(page.includes(field), `the plan body carries ${field}`);
  }
  // One request in flight per seat, and a retry is safe (server-deduped).
  assert.ok(page.includes("if (actingRef.current) return false;"));
  assert.ok(page.includes("res = await send();"));
  assert.ok(page.includes("// One retry — safe because the server dedupes on `actionId`."));
  // Every control is an authoritative action, not local state.
  for (const action of [
    'type: "deploy"',
    'type: "recall"',
    'type: "setRoute"',
    'type: "buy"',
    'type: "merge"',
    'type: "repair"',
    'type: "workshopRecovery"',
    'type: "lockIn"',
  ]) {
    assert.ok(page.includes(action), `the page sends ${action}`);
  }
});

test("the board is one oval with route lanes, seat colours and tier-scaled car sprites", () => {
  assert.ok(page.includes("<OvalTrack"), "the match page renders the oval");
  assert.ok(
    oval.includes('viewBox={`0 0 ${TRACK_VIEWBOX.width} ${TRACK_VIEWBOX.height}`}'),
    "the board is scalable SVG geometry",
  );
  assert.ok(oval.includes("LANE_ORDER.map"), "one band per route lane");
  assert.ok(oval.includes("finishSegments.map"), "a start/finish marking exists");
  assert.ok(oval.includes("directionChevrons()"), "the direction of travel is drawn");
  assert.ok(oval.includes("pointOnLane("), "cars follow the mathematical ellipse");
  assert.ok(oval.includes("pointOnRivalRing("), "a route-hidden rival grid has its own ring");
  // The box accessor is width-led for the tier and height-derived from the
  // artwork's own frame (a square box used to shrink the car to a dot).
  assert.ok(oval.includes("carSpriteBox("), "the sprite box encodes the tier");
  assert.ok(ovalMath.includes("player1: Object.freeze({"), "seat colours live in the geometry module");
  assert.ok(ovalMath.includes('dot: "#38bdf8"'), "Player 1 is blue");
  assert.ok(ovalMath.includes('dot: "#fb7185"'), "Player 2 is red");
  assert.ok(ovalMath.includes('1: 7, 2: 9, 3: 11, 4: 13'), "tier radii are distinct");
  assert.ok(oval.includes("<CarSprite"), "the board draws the shared car artwork");
  assert.ok(oval.includes("headingOnLane("), "route cars face along their lane");
  assert.ok(oval.includes("headingOnRivalRing("), "rival grid cars face along that grid's ellipse");
  assert.ok(carSprite.includes("<image"), "the sprite renders a real image asset");
});

test("car sprites replace the dots on the track, in the fleet and in the merge replay", () => {
  assert.ok(oval.includes('import CarSprite from "./CarSprite"'), "the board imports the shared sprite");
  assert.ok(garage.includes('import CarSprite from "./CarSprite"'), "the garage imports the same sprite");
  assert.ok(!oval.includes("function CarDot("), "the old dot renderer is gone");
  assert.ok(!garage.includes("FleetDot"), "the old fleet dot is gone");
  assert.ok(oval.includes("<CarMarker"), "grid and playback cars use the sprite marker");
  assert.ok(oval.includes("carSpriteRotation("), "the sprite is rotated to the ellipse tangent");
  assert.ok(
    oval.includes('const damaged = car.outcome === "dnf"'),
    "a confirmed DNF shows the damaged artwork",
  );
  assert.ok(
    garage.includes("damaged={Boolean(car.damaged)}"),
    "a damaged garage car shows the damaged artwork",
  );

  // The merge replay is still two sources converging into the confirmed tier.
  const mergeStart = garage.indexOf("Merge replay");
  const mergeEnd = garage.indexOf("{/* Buy + merge tools. */}", mergeStart);
  assert.ok(mergeStart > 0 && mergeEnd > mergeStart, "the merge replay exists");
  const merge = garage.slice(mergeStart, mergeEnd);
  assert.equal((merge.match(/<CarSprite/g) || []).length, 3, "both sources and the result are sprites");
  assert.ok(merge.includes("mergeAnim.tier + 1"), "the result is still the confirmed higher tier");

  // Every tier's intact and damaged asset is mapped at the public path.
  assert.ok(carSpriteData.includes('CAR_SPRITE_DIR = "/images/lane-rush/cars"'));
  for (const asset of ["compact", "sport", "supercar", "hypercar"]) {
    assert.ok(carSpriteData.includes(`${asset}.png`), `${asset} artwork is mapped`);
    assert.ok(carSpriteData.includes(`${asset}-damaged.png`), `${asset} damaged artwork is mapped`);
  }
  assert.ok(carSprite.includes("onError"), "a missing image falls back safely");
  assert.ok(carSprite.includes('role: "img"'), "a labelled sprite is exposed as an image");
  assert.ok(carSprite.includes('"aria-hidden": true'), "an unlabelled sprite is decorative");
});

test("sprite rendering preserves selection, labels and reduced motion", () => {
  assert.ok(oval.includes("selected={selected}"), "the selected grid car keeps its ring");
  assert.ok(oval.includes("selected={crossed}"), "the finish crossing keeps its ring");
  assert.ok(
    oval.includes('showResults && car.outcome === "finished"'),
    "points labels still render for a confirmed finish",
  );
  assert.match(oval, /DNF\s*<\/text>/, "the DNF label is still drawn");
  assert.ok(oval.includes("car.outcome === \"finished\" && !reduced"), "the finish flash survives");
  assert.ok(oval.includes("useReducedMotion"), "reduced motion stays supported");
  assert.ok(oval.includes("enabled: !reduced"), "reduced motion still pins to confirmed endpoints");
  // Selection still comes from the page's existing state.
  assert.ok(page.includes("selectedCarId={selectedCarId}"));
  assert.ok(page.includes("onSelectCar={"), "fleet selection is unchanged");
});

test("the oval is responsive and keeps the whole track on small screens", () => {
  assert.ok(oval.includes('className="block h-auto w-full select-none"'), "the board scales to its column");
  assert.ok(oval.includes("preserveAspectRatio") === false, "the viewBox handles the aspect ratio");
  // The two-column desktop layout collapses to one column on small screens.
  assert.ok(page.includes("grid gap-3 lg:grid-cols-[minmax(0,1fr)_23rem]"));
  assert.ok(page.includes("sm:grid-cols-2"), "seat cards and garage cards adapt");
});

test("animations are presentation-only and replay the SERVER's resolved round", () => {
  // The board's one source of moving cars is the confirmed result projection…
  assert.ok(page.includes("lastResult={playbackResult}"), "the board replays only a confirmed round");
  assert.ok(page.includes("setPlaybackResult(latest)"), "a new round starts the replay");
  assert.ok(page.includes("seenRoundRef.current === null"), "the first payload seeds a baseline");
  assert.ok(page.includes("seenRoundRef.current = latestRound;"), "each round plays once");
  assert.ok(oval.includes("buildRacePlayback(lastResult)"), "the projection lives in the track");
  assert.ok(ovalMath.includes("export function buildRacePlayback("), "and is pure");
  // It never rolls, scores or decides anything client-side.
  assert.ok(!page.includes("Math.random"), "the client never draws a roll");
  assert.ok(!oval.includes("Math.random"), "the board never draws a roll");
  assert.ok(!page.includes("setMatch((cur)"), "no animation writes match state");
  assert.ok(!page.includes("onAnimationComplete={() => setMatch"), "no animation callback awards points");
  // Scores animate to the already-confirmed value.
  assert.ok(page.includes("function useConfirmedScore(value, enabled)"));
  assert.ok(page.includes("previousRef.current = target;"), "the confirmed value is the endpoint");
  // Reduced motion pins every dot instead of animating it.
  assert.ok(oval.includes("useReducedMotion"));
  assert.ok(oval.includes("enabled: !reduced"));
  assert.ok(garage.includes("useReducedMotion"));
});

test("the gameplay interface exposes every planning control with a disabled reason", () => {
  assert.ok(page.includes('data-testid="lane-runner-lock"'), "Lock in plan exists");
  assert.ok(page.includes("Lock in plan"), "…labelled plainly");
  assert.ok(page.includes("Rival {oppLocked ? \"locked\" : \"open\"}"), "opponent lock status is shown");
  assert.ok(page.includes('data-testid="lane-runner-clock"'), "the 60s countdown is visible");
  assert.ok(page.includes('<PlanningClock secondsLeft={secondsLeft} />'));
  assert.ok(page.includes('data-testid="lane-runner-resign"'), "a resign control exists");
  assert.ok(page.includes('data-testid="lane-runner-phase"'), "the round phase is visible");
  assert.ok(page.includes("First to {WIN_SCORE.toLocaleString()}"), "the victory target is visible");
  // The fleet panel owns deploy / recall / route / buy / merge / repair.
  assert.ok(page.includes("<RaceGarage"), "the garage is a first-class panel");
  assert.ok(garage.includes('data-testid="lane-runner-buy"'));
  assert.ok(garage.includes('data-testid="lane-runner-merge"'));
  assert.ok(garage.includes("Return to garage"), "a deployed car can be recalled");
  assert.ok(garage.includes("Repair {REPAIR_COST.scrap} Scrap"), "repair is offered with its cost");
  assert.ok(garage.includes("RouteChips"), "route selection is per car");
  assert.ok(garage.includes("actionPoints"), "remaining action points are shown");
  assert.ok(garage.includes("Damaged") && garage.includes("Available"), "car status is explicit");
  assert.ok(garage.includes("Free workshop recovery"), "the soft-lock escape hatch is offered");
  // Disabled controls explain themselves rather than silently doing nothing.
  assert.ok(garage.includes("disabledReason") && garage.includes("title={disabled ? disabledReason"));
  assert.ok(garage.includes("buyReason") && garage.includes("mergeReason"));
});

test("win, loss and draw are presented from the server's seat-based verdict", () => {
  assert.ok(page.includes("viewerOutcome({"));
  assert.ok(page.includes("viewerSeat: mySeat,"));
  assert.ok(page.includes('<PvpResultScreen open {...resultScreenProps} />'));
  assert.ok(page.includes("Tie-break: you led on total points"), "the tie-break is explained");
  assert.ok(page.includes("Tie-break: your rival led on total points"));
  assert.ok(page.includes("exact dead heat"), "an exact draw is named");
  assert.ok(page.includes("Resignation"), "a resignation is named");
  assert.ok(page.includes("sides: ["), "both finals scores are shown");
  // The lobby CTA is a game link, never the forbidden "Return to Lobby" exit.
  assert.ok(page.includes('secondaryAction: { label: "Back to Lane Rush"'));
  assert.ok(!page.includes("onReturnToLobby"));
});

test("the client never offers a removed mechanic", () => {
  for (const dead of [
    "canHold",
    "banked",
    "unbanked",
    "peek",
    "riskPath",
    "RISK_PATHS",
    "bankPending",
    "hold",
  ]) {
    assert.ok(!page.includes(dead), `removed mechanic "${dead}" must not appear in the UI`);
  }
  // The legacy bridge engine still ships for unfinished rows, so its glass-break
  // cue stays in the shared audio module.
  assert.ok(audio.includes("export function playGlassBreak("));
});

test("an API failure can't leave the duel silently frozen", () => {
  assert.ok(page.includes("syncFailures"));
  assert.ok(page.includes("Reconnecting…"));
  assert.ok(page.includes("setSyncFailures(0)"));
});

test("a failed load offers a retry instead of a dead end", () => {
  assert.ok(page.includes("Couldn't load the duel:"));
  assert.ok(page.includes("onClick={() => fetchStatus()}"));
  assert.ok(page.includes("Match not found or you are not a participant."));
});

test("no async handler can surface an unhandled promise rejection", () => {
  assert.ok(page.includes('setError("Network error — could not resign.")'));
  assert.ok(page.includes('setError("Network error — could not cancel.")'));
  assert.ok(
    page.includes('setError("Network error — your action was not sent. Try again.")'),
  );
  // The action handler already retries once before surfacing the failure.
  assert.ok(page.includes("res = await send();\n        } catch {\n          // One retry"));
  // Clipboard writes are permissions-gated and must not reject unhandled.
  const clipboardCalls = page.match(/writeText\(window\.location\.href\)/g) || [];
  const guardedCalls =
    page.match(/writeText\(window\.location\.href\)\s*\?\.catch\(\(\) => \{\}\)/g) || [];
  assert.ok(clipboardCalls.length >= 2, "both invite-link copies are wired");
  assert.equal(guardedCalls.length, clipboardCalls.length);
});

// ════════════════════════════════════════════════════════════════════
// Server: one authoritative transition
// ════════════════════════════════════════════════════════════════════

test("the server guards the tile choice: current player, its own row, no replay", () => {
  // Only the current player may select a tile…
  assert.ok(
    store.includes("if (!match.currentTurnUserId || match.currentTurnUserId !== userId)"),
  );
  // …on the row that player is actually standing on…
  assert.ok(store.includes("selectedRow !== currentRow"));
  // …and a replayed action must not advance the game twice.
  assert.ok(store.includes("hasResolvedActionId(match.actions, actionId)"));
  assert.ok(store.includes("duplicate: true"));
});

test("no action is ever parked as pending anymore (stranded-action bug)", () => {
  assert.ok(!store.includes("parkPendingAction"));
  assert.ok(!store.includes("releasePendingActions"));
  assert.ok(!store.includes("pending: true"), "no code path may create a pending action");
  // The one live transition is the tile-selection jump.
  assert.ok(store.includes("async function applyBridgeJump"));
  assert.ok(store.includes("bridgeTurnAfterJump"));
});

test("only crossing row 10 (or a resignation) settles the match", () => {
  // The single terminal check inside the live transition: a fall never
  // settles — it resets the attempt and hands the turn over.
  assert.ok(store.includes("if (turn.ended)"));
  assert.ok(store.includes('reason: "crossed_bridge"'));
  assert.ok(store.includes("currentTurnUserId: turn.turnUserId"));
  // The old completion / both-ended settlement paths are gone.
  assert.ok(!store.includes('reason: "completed"'));
  assert.ok(!store.includes("resolveByFinalScores"));
  assert.ok(!store.includes("advanceTurn"));
});

test("the bot path dedupes wake-ups too", () => {
  assert.ok(aiRoute.includes("actionId"));
  assert.ok(store.includes("hasResolvedActionId(match.actions, actionId)"));
  assert.ok(store.includes("if (actionId) entry.actionId = String(actionId);"));
  // The bot may only act while it owns the turn.
  assert.ok(store.includes("if (match.currentTurnUserId !== BOT_USER_ID) return match;"));
});

test("the act route forwards actionId + row and treats a duplicate as success", () => {
  assert.ok(actRoute.includes("const actionId = body?.actionId ?? null;"));
  assert.ok(actRoute.includes("const row = body?.row ?? null;"));
  assert.ok(actRoute.includes("if (result.duplicate)"));
  assert.ok(actRoute.includes("duplicate: true"));
});

// ════════════════════════════════════════════════════════════════════
// The 15s decision timer — server-authoritative
// ════════════════════════════════════════════════════════════════════

test("an expired choice window ends the attempt — it never picks or breaks a tile", () => {
  const begin = store.indexOf("async function timeoutAttempt");
  assert.ok(begin > 0, "the timeout transition must exist");
  const body = store.slice(
    begin,
    store.indexOf("export function scrubMatchForViewer", begin),
  );

  // A timeout touches no tile, so no bad tile can break and nothing leaks.
  assert.ok(!body.includes("resolveJump("), "a timeout must not resolve a jump");
  assert.ok(!body.includes("Math.random"), "a timeout must not pick a tile");
  assert.ok(!body.includes("broken"), "a timeout must not break a tile");
  assert.ok(!body.includes("tile:"), "a timeout must record no tile");

  // It ends the attempt: reset the row, hand over the turn, restart the window.
  assert.ok(body.includes("[turn.rowField]: turn.row"));
  assert.ok(body.includes("currentTurnUserId: turn.turnUserId"));
  assert.ok(body.includes("roundDeadline: nextTurnDeadline()"));
  assert.ok(body.includes("action: BRIDGE_ACTIONS.TIMEOUT"));
});

test("the window is enforced on the write path too (a late tile cannot win)", () => {
  // `act` refuses a tile submitted after `roundDeadline` and resolves the
  // expiry instead, so a slow client or a lagging device clock buys no time.
  assert.ok(store.includes("new Date(match.roundDeadline).getTime() <= Date.now()"));
  assert.ok(store.includes('error: "Time ran out — the attempt ended"'));
  // …and the state that move produced is still pushed to the opponent.
  assert.ok(actRoute.includes("if (result.timedOut)"));
  assert.ok(actRoute.includes('action: "timeout"'));
});

// ════════════════════════════════════════════════════════════════════
// Memory flags — server-validated, public, append-only, 2 per match
// ════════════════════════════════════════════════════════════════════

test("a flag action is validated against the seat's OWN landing, not the request", () => {
  const begin = store.indexOf("if (wantsFlag) {");
  assert.ok(begin > 0, "the store must handle the flag action");
  const branchEnd = store.indexOf("const currentRow = seatRow(match, seat);", begin);
  assert.ok(branchEnd > begin);
  const body = store.slice(begin, branchEnd);

  // The client proposes coordinates; the SERVER decides whether its own
  // history shows that seat landing there safely.
  assert.ok(body.includes("canPlaceFlag({"));
  assert.ok(body.includes("row: selectedRow"));
  assert.ok(body.includes("tile: selectedTile"));
  assert.ok(body.includes("status: 409"), "an illegal flag is refused");
  // The gate itself lives in the engine and reads the seat's own history.
  assert.ok(constants.includes("if (!landedSafelyOn(match, seat, r, t))"));
  assert.ok(constants.includes("export function landedSafelyOn"));
  assert.ok(constants.includes("a.seat === seat"));

  // "flag" is an accepted action alongside the tile choice.
  assert.ok(store.includes("const wantsFlag = actAction === BRIDGE_ACTIONS.FLAG;"));
});

test("a flag never consumes the turn and never touches board state", () => {
  const begin = store.indexOf("if (wantsFlag) {");
  const body = store.slice(
    begin,
    store.indexOf("const currentRow = seatRow(match, seat);", begin),
  );

  // The flag branch runs BEFORE the turn check: a flag is not a tile choice.
  assert.ok(begin < store.indexOf("ONLY THE CURRENT PLAYER MAY ACT"));
  // …and it writes nothing but the flag column.
  for (const forbidden of [
    "currentTurnUserId:",
    "roundDeadline:",
    "[turn.rowField]",
    "p1Row:",
    "p2Row:",
    "status: MATCH_STATUS",
    "broken",
    "actions:",
  ]) {
    assert.ok(!body.includes(forbidden), `a flag must not write ${forbidden}`);
  }
  assert.ok(body.includes("[placement.field]: placement.flags"));
});

test("a flag column is append-only — no jump can move or remove a flag", () => {
  // The bridge transition no longer rewrites the flag columns at all.
  const jumpBody = store.slice(
    store.indexOf("async function applyBridgeJump"),
    store.indexOf("async function resolveMatch"),
  );
  assert.ok(!jumpBody.includes("p1Flags:"));
  assert.ok(!jumpBody.includes("p2Flags:"));
  assert.ok(!jumpBody.includes("dropBrokeFlags"));
  // …so every write to a flag column happens inside the flag branch, and it
  // appends (existing list first, the new flag last).
  const begin = store.indexOf("if (wantsFlag) {");
  const end = store.indexOf("const currentRow = seatRow(match, seat);", begin);
  let at = store.indexOf("[placement.field]: placement.flags");
  assert.ok(at > 0, "the flag column write must exist");
  let writes = 0;
  while (at !== -1) {
    assert.ok(at > begin && at < end, "only the flag branch writes a flag column");
    writes += 1;
    at = store.indexOf("[placement.field]: placement.flags", at + 1);
  }
  assert.ok(writes >= 1);
  assert.ok(constants.includes("const flags = ["));
  assert.ok(constants.includes("...flagsOf(match, seat),"));
});

test("flags are PUBLIC: both seats' flags ride the payload and the live event", () => {
  // The match payload carries both seats' flags, their remaining budget and
  // the per-match cap — flags are visible to both players.
  assert.ok(matchRoute.includes("myFlags: flagsOf(match, seat)"));
  assert.ok(matchRoute.includes("oppFlags: flagsOf(match, opponentSeat)"));
  assert.ok(matchRoute.includes("myFlagsLeft: flagsLeftForSeat(match, seat)"));
  assert.ok(matchRoute.includes("oppFlagsLeft: flagsLeftForSeat(match, opponentSeat)"));
  assert.ok(matchRoute.includes("flagsPerPlayer: BRIDGE_FLAGS_PER_PLAYER"));
  // A newly placed flag is pushed on the SAME event as a broken tile, with
  // both public lists, so neither seat waits for a poll.
  assert.ok(actRoute.includes("flagPlaced: result.flagPlaced ?? null"));
  assert.ok(actRoute.includes("p1Flags: Array.isArray(result.p1Flags)"));
  assert.ok(actRoute.includes("p2Flags: Array.isArray(result.p2Flags)"));
  // Flags are server-derived: a client cannot post flags or a broken set.
  assert.ok(!actRoute.includes("body?.flags"));
  assert.ok(!actRoute.includes("body?.broken"));
});

test("flags are per-match and reset with every new match", () => {
  const schema = read("src/db/schema.ts");
  assert.ok(
    /p1Flags: jsonb\("p1_flags"\)[\s\S]{0,120}?default\(sql`'\[\]'::jsonb`\)/.test(schema),
    "p1_flags defaults to []",
  );
  assert.ok(
    /p2Flags: jsonb\("p2_flags"\)[\s\S]{0,120}?default\(sql`'\[\]'::jsonb`\)/.test(schema),
    "p2_flags defaults to []",
  );
  const migration = read("src/db/migrations/0163_lane_rush_shared_bridge.sql");
  assert.ok(migration.includes('"p1_flags" jsonb NOT NULL DEFAULT \'[]\'::jsonb'));
  assert.ok(migration.includes('"p2_flags" jsonb NOT NULL DEFAULT \'[]\'::jsonb'));
  // The cap is a single shared constant (BRIDGE_FLAGS_PER_PLAYER = 2), never
  // duplicated per call site — the engine owns the budget.
  assert.ok(constants.includes("flagsLeftForSeat(match, seat) <= 0"));
  assert.ok(constants.includes("BRIDGE_FLAGS_PER_PLAYER - bridgeFlagsUsedBySeat(match, seat)"));
  assert.ok(constants.includes("export const BRIDGE_FLAGS_PER_PLAYER = 2;"));

  // ANTI-ORACLE: flag validation must never consult the hidden solution — it
  // may read the geometry only, and decides purely from the seat's own
  // landings. So a flag request cannot be used to probe safe/bad state.
  const canFlagBody = constants.slice(
    constants.indexOf("export function canPlaceFlag"),
    constants.indexOf("export function flagPlacement"),
  );
  assert.ok(canFlagBody.includes("landedSafelyOn"));
  assert.ok(!canFlagBody.includes("isBridgeTileBad"));
  assert.ok(!canFlagBody.includes("badTiles"));
  assert.ok(!canFlagBody.includes("bridge?.rows"));
});

// ════════════════════════════════════════════════════════════════════
// Permanent broken-tile state — pushed to BOTH seats over Socket.IO
// ════════════════════════════════════════════════════════════════════

test("the broken tile is pushed to both seats on the existing match event", () => {
  // The store reports exactly which tile broke (and whether it was new), so the
  // routes can announce it. Reuses `broadcastMatchUpdate` — no new event.
  assert.ok(store.includes("function brokeTileSignal({ outcome, brokenBefore = [] })"));
  assert.ok(store.includes("newlyBroken: Boolean("));
  assert.ok(store.includes("isTileBroken(brokenBefore, brokeTile.row, brokeTile.tile)"));

  // Human jump → act route; bot jump → ai-turn route. Both push it.
  for (const route of [actRoute, aiRoute]) {
    assert.ok(route.includes("broadcastMatchUpdate(matchId, {"));
    assert.ok(route.includes("brokeTile: result.newlyBroken ? result.brokeTile : null"));
    assert.ok(route.includes("broken: Array.isArray(result.broken) ? result.broken : undefined"));
  }
  // The room broadcast reaches every socket in the per-match room (both seats).
  const rooms = read("src/lib/lane-rush-duel/rooms.js");
  assert.ok(rooms.includes("io.to(roomId).emit(LANE_RUSH_DUEL_MATCH_UPDATED"));
});

test("the realtime + payload path never leaks the bridge layout", () => {
  // What travels: the ONE tile that broke + the public broken list. What never
  // travels: the layout's `badTiles`, or any per-row safe/bad answer.
  assert.ok(!actRoute.includes("badTiles"));
  assert.ok(!aiRoute.includes("badTiles"));
  assert.ok(!store.includes("brokeTile: outcome"), "the raw outcome must not be relayed whole");
  // The match payload hands out the scrubbed client view + the public list.
  assert.ok(matchRoute.includes("broken: brokenTilesOf(match)"));
  // Clients never send broken state — it is server-derived only.
  assert.ok(!actRoute.includes("body?.broken"));
  assert.ok(!actRoute.includes("broken ="), "a client cannot post a broken tile");
});

test("the countdown is display-only and reconnects get the server's remaining time", () => {
  // The payload carries absolute server time alongside the deadline, so a
  // client (or a reconnect) measures `roundDeadline - serverNow` rather than
  // trusting its own clock.
  assert.ok(matchRoute.includes("serverNow: new Date().toISOString()"));
  assert.ok(page.includes("const [clockOffsetMs, setClockOffsetMs] = useState(0)"));
  assert.ok(page.includes("const serverNowMs = now === null ? null : now + clockOffsetMs"));
  assert.ok(page.includes("Math.max(0, Math.ceil((deadlineMs - serverNowMs) / 1000))"));
  // The only thing the client does at 0 is ASK the server (a GET) — deduped per
  // deadline, so it can never spam, and it never decides anything itself.
  assert.ok(page.includes("expiredDeadlineRef.current === deadlineMs"));
  assert.ok(page.includes("expiredDeadlineRef.current = deadlineMs"));
  assert.ok(page.includes("fetchStatus();"));
  assert.ok(
    !page.includes("setMatch((cur) => ({ ...cur, p1Row"),
    "the client never resolves the timeout itself",
  );
});

// ════════════════════════════════════════════════════════════════════
// Legacy mechanics removal
// ════════════════════════════════════════════════════════════════════

test("the legacy points / banking server logic is gone", () => {
  // The bridge redesign has NO points, NO banking, NO multipliers and NO
  // peek: none of that state may survive on the server.
  assert.ok(!store.includes("bankedTotal = scoreFromActions"));
  assert.ok(!store.includes("WIN_BANKED_SCORE"));
  assert.ok(!store.includes("applyEntryImmediately"));
  assert.ok(!store.includes("bankedGainOnHold"));
  assert.ok(!store.includes("scoreFromActions"));
  assert.ok(!store.includes("buildPlayerTower"));
  assert.ok(!store.includes("decideBotAction("));
  // The one live transition is the tile-selection jump.
  assert.ok(store.includes("async function applyBridgeJump"));
  assert.ok(store.includes("bridgeTurnAfterJump"));
});

test("the constants module exports no removed mechanic", () => {
  for (const dead of [
    "RISK_PATHS",
    "RISK_PATH_KEYS",
    "LANE_POINTS",
    "DIFFICULTY_POINT_MULT",
    "WIN_BANKED_SCORE",
    "MAX_PEEKS",
    "buildPlayerTower",
    "scoreFromActions",
    "bankedScoreOf",
  ]) {
    assert.ok(
      !new RegExp(`export (const|function) ${dead}\\b`).test(constants),
      `constants must not export removed mechanic ${dead}`,
    );
  }
  assert.ok(constants.includes("export const BRIDGE_ROWS = 10;"));
  assert.ok(constants.includes("export const BRIDGE_TILE_CHOICE_SECONDS = 15;"));
});
