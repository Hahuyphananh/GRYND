/**
 * Lane Rush Duel — UI + server contract tests.
 *
 * These lock in the fixes that can't be exercised from pure functions:
 *   * the tile hitbox (48px min, 56px on desktop, whole tile clickable,
 *     board scrolls instead of crushing the rows),
 *   * the client's out-of-order reconcile guard (only the newest status
 *     response may write state), idempotent action submits, and timer /
 *     listener cleanup,
 *   * bust feedback so a red tile never looks ignored,
 *   * the server's single authoritative transition: idempotency by
 *     actionId, staleness by row, and no action ever parked as
 *     `pending` (the old stranded-action path).
 *
 * Run:  node --import tsx --test tests/lane-rush-duel-ui-contract.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Normalise CRLF so multi-line structural assertions work on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const page = read("src/app/casino/lane-runner/[matchId]/PageClient.jsx");
const store = read("src/lib/lane-rush-duel/serverStore.js");
const actRoute = read("src/app/api/lane-rush-duel/match/[matchId]/act/route.js");
const aiRoute = read("src/app/api/lane-rush-duel/match/[matchId]/ai-turn/route.js");

// Whitespace-insensitive view of the page. Multi-line JSX attribute VALUES
// (a ternary spread over several lines) get reflowed whenever another guard
// is added to them, and the assertion should test the guard, not the
// indentation.
const flat = (s) => s.replace(/\s+/g, " ");
const pageFlat = flat(page);

// ════════════════════════════════════════════════════════════════════
// Tile hitboxes / responsive board
// ════════════════════════════════════════════════════════════════════

test("tiles have a real, tappable hitbox (48px min, 56px on desktop)", () => {
  assert.ok(page.includes("min-h-[48px]"), "tiles need a 48px min height");
  assert.ok(page.includes("min-w-[44px]"), "tiles need a 44px min width");
  assert.ok(page.includes("sm:min-h-[56px]"), "desktop tiles need 56px height");
  assert.ok(
    page.includes("touch-manipulation"),
    "tiles must not delay touch taps",
  );
  assert.ok(page.includes("select-none"));
});

test("the whole visible tile is the click target", () => {
  assert.ok(page.includes("onClick={() => tileCanPick && onPick(tileIdx)}"));
  // One button per tile — no invisible overlay / sized-down inner span.
  assert.ok(
    pageFlat.includes(
      "whileTap={ tileCanPick && !shouldReduce ? { scale: 0.96 } : undefined }",
    ),
    "the whole tile is a real button whose press feedback is reduced-motion aware",
  );
  // The old crushed-tile recipe (h-full + 10px glyph, auto row height)
  // is gone.
  assert.ok(
    !page.includes("gridAutoRows"),
    "tiles must not be sized by an auto grid row + h-full",
  );
  assert.ok(!page.includes("h-full rounded border text-[10px] font-bold"));
});

test("the board scrolls instead of shrinking tiles out of the hitbox", () => {
  assert.ok(
    page.includes("overflow-y-auto overscroll-contain"),
    "the tower must scroll",
  );
  assert.ok(
    page.includes("min-h-[84px]"),
    "each lane row keeps a min height so tiles can't be clipped",
  );
  assert.ok(page.includes("aria-label={`Level ${laneIdx + 1} tile"));
});

// ════════════════════════════════════════════════════════════════════
// Client state-sync safety
// ════════════════════════════════════════════════════════════════════

test("only the newest status response may write match state", () => {
  assert.ok(page.includes("syncSeqRef"), "needs a reconcile sequence guard");
  assert.ok(page.includes("seq !== syncSeqRef.current"));
  assert.ok(page.includes("new AbortController()"));
  assert.ok(
    page.includes("syncAbortRef.current?.abort()"),
    "a newer reconcile must supersede the in-flight one",
  );
  assert.ok(page.includes("if (e?.name === \"AbortError\") return null;"));
});

test("player actions are idempotent and row-stamped", () => {
  assert.ok(page.includes("actionIdRef.current += 1"));
  assert.ok(page.includes("actionId"), "actions must carry a unique id");
  assert.ok(
    page.includes("round: myLane"),
    "actions must carry the row the click was rendered against",
  );
  // A network failure retries the SAME action once — safe because the
  // server dedupes on actionId.
  assert.ok(page.includes("res = await send();"));
});

test("timers, listeners and in-flight requests are cleaned up", () => {
  assert.ok(page.includes("clearInterval(interval)"), "poll interval cleanup");
  assert.ok(page.includes("clearInterval(t)"), "clock interval cleanup");
  assert.ok(page.includes("clearTimeout(timer)"), "bot timer cleanup");
  assert.ok(page.includes('socket.off(LANE_RUSH_DUEL_MATCH_UPDATED, refresh)'));
  assert.ok(page.includes('socket.emit("leave_room"'));
  assert.ok(
    page.includes("syncAbortRef.current = null;"),
    "unmount must drop the in-flight reconcile reference",
  );
  assert.ok(page.includes("mountedRef.current = false;"));
  assert.ok(
    !page.includes("setTimeout(() => {\n          pickedRef.current = false;\n        }, 600)"),
    "the artificial 600ms click lockout must be gone",
  );
});

test("the in-flight guard is released as soon as the action settles", () => {
  assert.ok(page.includes("if (!matchId || actingRef.current) return;"));
  assert.ok(page.includes("actingRef.current = false;"));
  assert.ok(!page.includes("pickedRef"));
});

test("the bot trigger is deduped, scoped to live play, and mount-safe", () => {
  assert.ok(page.includes("botTurnFiredRef"));
  assert.ok(page.includes('match?.status === "active"'));
  assert.ok(page.includes("body: JSON.stringify({ actionId })"));
  assert.ok(page.includes("if (!mountedRef.current) return;"));
});

test("an API failure can't leave the duel silently frozen", () => {
  assert.ok(page.includes("syncFailures"));
  assert.ok(page.includes("Reconnecting…"));
  assert.ok(page.includes("setSyncFailures(0)"));
});

// ════════════════════════════════════════════════════════════════════
// Bust ("red tile") feedback
// ════════════════════════════════════════════════════════════════════

test("a bust is rendered, announced and never ends the duel", () => {
  assert.ok(page.includes("bustsByLaneForSeat"));
  assert.ok(page.includes("latestBustFor"));
  assert.ok(page.includes("bustByLane={myBustByLane}"));
  assert.ok(page.includes("oppBustByLane={oppBustByLane}"));
  assert.ok(page.includes("Bust on level"));
  assert.ok(page.includes("is safe and the duel"));
  // Audio feedback fires on a new bust.
  assert.ok(page.includes("playBuzz()"));
  // Unbanked vs banked is shown explicitly.
  assert.ok(page.includes("At risk"));
  assert.ok(page.includes("banked"));
});

test("bust feedback fires once and never on a poll/socket refresh", () => {
  // Identity of the bust, not of the poll.
  assert.ok(page.includes("const bustKeyOf = (bust) =>"));
  assert.ok(page.includes("const myBustKey = bustKeyOf(myLastBust);"));
  assert.ok(
    page.includes("lastBustSeenRef.current === myBustKey"),
    "the buzz must be deduped by bust identity",
  );
  // What was already busted when the page loaded is a baseline, not news
  // — a refresh must not buzz or re-animate an old bust.
  assert.ok(page.includes("loadBustKeysRef.current === null"));
  assert.ok(page.includes("if (loadBustKeysRef.current?.has(myBustKey)) return;"));
  // A NEW duel gets a clean feedback baseline.
  assert.ok(page.includes("lastBustSeenRef.current = null;"));
  assert.ok(page.includes("loadBustKeysRef.current = null;"));
  // Same bust => same element => the one-shot entrance cannot restart.
  assert.ok(page.includes("key={myBustKey}"));
});

test("bust feedback states what was lost and that the duel continues", () => {
  // The figure comes from replaying the immutable history, so a refresh
  // can never change it.
  assert.ok(page.includes("unbankedLostOnBust("));
  assert.ok(page.includes("−${myBustLoss.toLocaleString()} unbanked"));
  assert.ok(page.includes("−{bustLoss.toLocaleString()}"));
  // A bust that cost nothing must not claim a loss.
  assert.ok(page.includes("Bust · no unbanked lost"));
  assert.ok(page.includes("no unbanked lost"));
  // Announced for screen readers, inline (never over the board), and it
  // never implies the match is over.
  assert.ok(page.includes('role="status"'));
  assert.ok(page.includes('aria-live="polite"'));
  assert.ok(page.includes("your unbanked run was lost"));
  // One-shot animation, not a permanent pulse.
  assert.ok(page.includes("? BUST_TILE_FLASH"));
  assert.ok(page.includes("BUST_TILE_TRANSITION"));
  assert.ok(!page.includes("BUST_TILE_INITIAL"));
});

// ════════════════════════════════════════════════════════════════════
// Safe-tile (success) feedback
// ════════════════════════════════════════════════════════════════════

test("a tapped tile shows press feedback immediately, before any response", () => {
  assert.ok(page.includes("const [pendingTile, setPendingTile] = useState(null);"));
  assert.ok(
    page.includes("setPendingTile({ lane: clickedLane, tile: clickedTile })"),
    "the tap must be marked in flight synchronously",
  );
  // It is reported as PENDING — a white ring and a “…” glyph, never the
  // success styling and never a points/score claim.
  assert.ok(page.includes("ring-2 ring-white/80"));
  assert.ok(page.includes('glyph = "…"'));
  assert.ok(
    page.includes("} else if (tileIsPending) {"),
    "the marker is scoped to the row",
  );
  assert.ok(page.includes("pendingTile?.lane === laneIdx"));
  assert.ok(page.includes("pendingTile={pendingTile}"));
  // The whole row keeps its colours while an action is in flight (no
  // grey flash), and the pending marker is released when it settles.
  assert.ok(page.includes('PATH_STYLE[lanePath].tile + " opacity-55"'));
  const doBody = page.slice(
    page.indexOf("const send = () =>"),
    page.indexOf("const cancelLobby = useCallback"),
  );
  assert.ok(doBody.includes("setPendingTile(null)"), "pending must be released");
});

test("the confirmation fires only after the server's state says the tile was safe", () => {
  const doBody = page.slice(
    page.indexOf("const send = () =>"),
    page.indexOf("const cancelLobby = useCallback"),
  );
  const armAt = doBody.indexOf("armConfirm(clickedLane, clickedTile)");
  assert.ok(armAt > -1, "the confirm must be armed from the action handler");
  // After the request was accepted…
  assert.ok(doBody.indexOf("if (!res.ok || !json.success)") < armAt);
  // …and after the AUTHORITATIVE resync, whose history must show this
  // exact tile as the newest non-bust action. A 2xx alone proves nothing
  // (a red tile succeeds too).
  assert.ok(doBody.indexOf("await fetchStatus()") < armAt);
  assert.ok(doBody.includes("lastActionForSeat(synced.actions, mySeat)"));
  assert.ok(doBody.includes("resolved.safe !== false"), "a bust must never confirm");
  assert.ok(doBody.includes("resolved.action !== \"hold\""));
  assert.ok(doBody.includes("Number(resolved.round ?? resolved.lane) === clickedLane"));
  assert.ok(doBody.includes("Number(resolved.tile) === clickedTile"));
  // Armed from exactly one place (the action handler), never from a poll.
  assert.equal((page.match(/armConfirm\(/g) || []).length, 1);
  assert.ok(page.includes("const armConfirm = useCallback"));
  assert.ok(page.includes("      armConfirm,\n"), "wired into the callback deps");
});

test("the success pop is short, one-shot, and rests afterwards", () => {
  assert.ok(page.includes("const CONFIRM_TILE_FLASH = { scale: [0.94, 1.12, 1] }"));
  assert.ok(page.includes("const CONFIRM_TILE_TRANSITION = { duration: 0.34"));
  assert.ok(page.includes("tileIsConfirming"), "the tile reads the confirm state");
  assert.ok(page.includes("confirmTile?.lane === laneIdx"));
  assert.ok(page.includes("confirmTile={confirmTile}"));
  // It clears itself on a short timer, so a resolved tile is calm again.
  assert.ok(page.includes("setConfirmTile({ lane, tile })"));
  assert.ok(page.includes("}, 520);"), "the confirmation is short-lived");
  assert.ok(page.includes("setConfirmTile(null)"));
  // Timer cleanup on both paths (unmount + new match) — no stray timers.
  assert.equal((page.match(/clearTimeout\(confirmTimerRef\.current\)/g) || []).length, 3);
});

test("polling/socket refreshes can never trigger or replay tile feedback", () => {
  const fetchBody = page.slice(
    page.indexOf("const fetchStatus = useCallback"),
    page.indexOf('const finished = match?.status === "finished";'),
  );
  assert.ok(fetchBody.length > 0);
  assert.ok(!fetchBody.includes("setConfirmTile"), "a poll must not confirm a tile");
  assert.ok(!fetchBody.includes("setPendingTile"), "a poll must not press a tile");
  assert.ok(!fetchBody.includes("armConfirm"));
  assert.ok(!fetchBody.includes("setBankConfirm"), "a poll must not confirm a bank");
  assert.ok(!fetchBody.includes("setBankPending"), "a poll must not flag a bank");
  assert.ok(!fetchBody.includes("armBankConfirm"));
  // Both states are plain client-local state, so re-renders that carry
  // the same match object cannot restart the one-shot animation.
  assert.ok(page.includes("const [confirmTile, setConfirmTile] = useState(null);"));
  assert.ok(page.includes("const confirmTimerRef = useRef(null);"));
});

test("success and bust stay visually distinct", () => {
  // Bust: red ✕ + shrink-pop + "lost unbanked" copy.
  assert.ok(page.includes("BUST_TILE_FLASH"));
  assert.ok(page.includes("from-red-600 to-rose-900"));
  // The bust copy states BOTH facts (what was lost, and that banked points
  // were not) — and it is the accessible name, so the loss is never
  // communicated by the red colour alone.
  assert.ok(page.includes("unbanked points lost"));
  assert.ok(page.includes(", your banked points are safe`"));
  // Success: emerald ring + bouncier pop + different aria copy.
  assert.ok(page.includes("ring-2 ring-emerald-200/90"));
  assert.ok(page.includes("CONFIRM_TILE_FLASH"));
  assert.ok(page.includes("added to your at-risk run"));
  // A bust keeps its own marker: the success ring is explicitly excluded.
  assert.ok(page.includes("if (tileIsConfirming && !tileIsMyBust)"));
  // …and one tile cannot be both at once. Both pops are ALSO gated on
  // reduced motion, and dropping the pop loses nothing: the red/emerald
  // look, the ✕/✓ glyph and the aria copy above are the information.
  assert.ok(
    pageFlat.includes(
      "shouldReduce ? undefined : tileIsMyBust ? BUST_TILE_FLASH : tileIsConfirming ? CONFIRM_TILE_FLASH : undefined",
    ),
    "the tile pops must opt out of movement under reduced motion",
  );
});

// ════════════════════════════════════════════════════════════════════
// Banking feedback
// ════════════════════════════════════════════════════════════════════

test("banking shows press + in-flight feedback on the button itself", () => {
  assert.ok(page.includes("const [bankPending, setBankPending] = useState(false);"));
  assert.ok(
    page.includes('if (action === "hold") setBankPending(true);'),
    "the bank must mark itself in flight",
  );
  assert.ok(page.includes('"Banking…"'), "the button reports the pending state");
  assert.ok(page.includes("disabled={!canHold || bankPending}"));
  // Press feedback only. The button no longer breathes permanently while
  // it is available (it is on screen for the whole match), so the cue for
  // a changed bankable amount is a one-shot keyed on that amount.
  assert.ok(
    pageFlat.includes(
      "whileTap={ canHold && !bankPending && !shouldReduce ? { scale: 0.97 } : undefined }",
    ),
  );
  assert.ok(
    pageFlat.includes("transition={ shouldReduce ? undefined : BANK_PRESS_TRANSITION }"),
  );
  assert.ok(page.includes("key={`bank-label-${myScore}`}"));
  const doBody = page.slice(
    page.indexOf("const send = () =>"),
    page.indexOf("const cancelLobby = useCallback"),
  );
  assert.ok(doBody.includes("setBankPending(false)"), "pending must be released");
});

test("the banking confirmation is armed only from the authoritative resync", () => {
  const doBody = page.slice(
    page.indexOf("const send = () =>"),
    page.indexOf("const cancelLobby = useCallback"),
  );
  const armAt = doBody.indexOf("armBankConfirm(resolved, synced.actions)");
  assert.ok(armAt > -1, "the confirm must be armed from the action handler");
  assert.ok(doBody.indexOf("await fetchStatus()") < armAt);
  assert.ok(
    doBody.indexOf('if (action === "hold" && resolved?.action === "hold")') < armAt,
    "only a bank that actually landed may confirm",
  );
  assert.equal((page.match(/armBankConfirm\(/g) || []).length, 1);
  // The "moved" figure is the display-only, history-derived gain.
  assert.ok(page.includes("bankedGainOnHold(actions, hold.seat, hold)"));
});

test("banking feedback is short, one-shot, and a stale timer can't clobber it", () => {
  assert.ok(page.includes("const BANK_ONESHOT = {"));
  assert.ok(page.includes("const BANK_BADGE_FLASH = { scale: [1, 1.22, 1] };"));
  assert.ok(page.includes("key={bankConfirm.key}"), "poll-proof identity");
  assert.ok(page.includes("}, 1800);"), "short-lived confirmation");
  assert.ok(
    page.includes("setBankConfirm((cur) => (cur && cur.key === key ? null : cur));"),
    "an older timer must not clear newer feedback",
  );
  // Timer cleanup on both paths + re-arm.
  assert.equal((page.match(/clearTimeout\(bankTimerRef\.current\)/g) || []).length, 3);
  // The protected total is emphasised once, never permanently pulsed.
  assert.ok(page.includes("motion.b"));
  assert.ok(
    pageFlat.includes(
      "animate={ bankConfirm && !shouldReduce ? BANK_BADGE_FLASH : undefined }",
    ),
    "the banked total's flash is reduced-motion aware",
  );
  assert.ok(page.includes("+{bankConfirm.moved.toLocaleString()}"));
  assert.ok(page.includes("Nothing new was at risk — "));
});

test("the banking rules themselves are untouched", () => {
  // The button's availability rule and the server's hold resolution are
  // exactly as before — only feedback was added.
  assert.ok(page.includes("const canHold = canAct && myScore > 0;"));
  assert.ok(store.includes("entry.bankedTotal = scoreFromActions(match.actions, seat);"));
  assert.ok(
    !store.includes("bankedGainOnHold"),
    "the display helper must never reach scoring/settlement",
  );
});

test("rate readouts can never render as NaN", () => {
  assert.ok(page.includes("Number.isFinite(Number(match?.myRate))"));
  assert.ok(page.includes("Number.isFinite(Number(match?.oppRate))"));
  assert.ok(!page.includes("Number(match?.myRate) ?? 1"));
});

// ════════════════════════════════════════════════════════════════════
// Final QA pass: state isolation, recovery, cleanup, no unhandled errors
// ════════════════════════════════════════════════════════════════════

test("a new matchId cannot inherit the previous duel's client state", () => {
  const reset = page.slice(page.indexOf("// A new matchId is a NEW duel"));
  const effect = reset.slice(0, reset.indexOf("]);"));
  assert.ok(effect.includes("setMatch(null)"), "stale board cleared");
  assert.ok(effect.includes("setError(null)"));
  assert.ok(effect.includes("setSyncFailures(0)"));
  assert.ok(effect.includes("setLastPeek(null)"));
  assert.ok(effect.includes('setSelectedPath("balanced")'));
  assert.ok(effect.includes("botTurnFiredRef.current = null"), "bot key cleared");
  assert.ok(effect.includes("syncSeqRef.current += 1"), "in-flight reconcile dropped");
  assert.ok(effect.includes("syncAbortRef.current?.abort()"));
  assert.ok(effect.includes("actingRef.current = false"));
  // The reset is declared BEFORE the poll effect, so it always runs first.
  assert.ok(
    page.indexOf("// A new matchId is a NEW duel") <
      page.indexOf("const interval = setInterval(fetchStatus, 5000)"),
  );
});

test("the live row is kept in view so its tiles stay clickable", () => {
  assert.ok(page.includes("const currentRowRef = useRef(null)"));
  assert.ok(page.includes('block: "nearest"'), "scrolls only as far as needed");
  assert.ok(page.includes("const didPlaceBoardRef = useRef(false)"));
  assert.ok(
    page.includes(
      'behavior: didPlaceBoardRef.current && !reduceMotion ? "smooth" : "auto"',
    ),
    "the board glides to the new row after the first paint",
  );
  assert.ok(
    page.includes('window.matchMedia?.("(prefers-reduced-motion: reduce)")'),
    "reduced motion keeps it instant",
  );
  assert.ok(page.includes("ref={isCurrent ? currentRowRef : undefined}"));
});

// ════════════════════════════════════════════════════════════════════
// Board movement / visual continuity
// ════════════════════════════════════════════════════════════════════

test("the live row arrives with a single state-driven move, nothing perpetual", () => {
  assert.ok(page.includes("const ROW_LIVE_ONESHOT = {"));
  assert.ok(page.includes("y: [7, 0]"), "the new row rises into place");
  assert.ok(page.includes("const ROW_LIVE_TRANSITION = { duration: 0.42"));  assert.ok(
    pageFlat.includes(
      "animate={isCurrent && !shouldReduce ? ROW_LIVE_ONESHOT : undefined}",
    ),
  );
  assert.ok(
    pageFlat.includes(
      "transition={ isCurrent && !shouldReduce ? ROW_LIVE_TRANSITION : undefined }",
    ),
  );
  // Only the live row is animated at all — the other seven never move.
  assert.ok(page.includes("key={laneIdx}"));
  assert.ok(
    page.includes("animate={isCurrent && !shouldReduce ?"),
    "the row animation is gated on being the live row (and on motion being wanted)",
  );
  // …and it is a one-shot: no repeat/Infinity anywhere in the row rule.
  const rowRule = page.slice(
    page.indexOf("const ROW_LIVE_ONESHOT"),
    page.indexOf("const PATH_STYLE"),
  );
  assert.ok(rowRule.length > 0);
  assert.ok(!rowRule.includes("repeat"));
  assert.ok(!rowRule.includes("Infinity"));
});

test("state changes fade and identity is stable, so nothing pops or remounts", () => {
  // Tile gradients can't interpolate, so the row wash carries the
  // transition instead of the tiles snapping between states.
  assert.ok(page.includes("transition-colors duration-300"));
  assert.ok(page.includes("rounded-lg border p-1.5 transition-colors"));
  // Rows and tiles keep their keys across state changes — no reordering,
  // no remount, and the board order itself is fixed.
  assert.ok(page.includes("rowsTopFirst"));
  assert.ok(page.includes("key={`${laneIdx}-${tileIdx}`}"));
  assert.ok(page.includes("rowsTopFirst.map((laneIdx) => {"));
});

test("every board animation is module-level, so a poll can't replay it", () => {
  const towerAt = page.indexOf("function DuelTower(");
  assert.ok(towerAt > 0);
  for (const constant of [
    "const ROW_LIVE_ONESHOT",
    "const BUST_TILE_FLASH",
    "const CONFIRM_TILE_FLASH",
    "const BANK_ONESHOT",
    "const BANK_BADGE_FLASH",
  ]) {
    const at = page.indexOf(constant);
    assert.ok(at > 0, `${constant} must exist`);
    assert.ok(at < towerAt, `${constant} must be module-level (stable identity)`);
  }
  // No extra motion machinery was pulled in.
  assert.ok(!/framer-motion\//.test(page));
  assert.equal((page.match(/from "framer-motion"/g) || []).length, 1);
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

test("the server guards player actions against duplicates and stale rows", () => {
  assert.ok(store.includes("hasResolvedActionId(match.actions, actionId)"));
  assert.ok(store.includes("isStaleRoundAction({ expectedRound: round, currentLane: lane })"));
  assert.ok(store.includes("duplicate: true"));
});

test("no action is ever parked as pending anymore (stranded-action bug)", () => {
  // Only `scrubMatchForViewer` may mention `pending: true` (when it
  // redacts a legacy entry) — no code path may CREATE one.
  const created = store.match(/pending: true/g) || [];
  assert.equal(
    created.length,
    1,
    "simultaneous play must never create a pending action",
  );
  assert.ok(!store.includes("entry.pending = true"));
  assert.ok(store.includes("actions: releasePendingActions(match.actions)"));
  assert.ok(!store.includes("parkPendingAction"));
});

test("a bust cannot settle the match: only a banked target / resign can", () => {
  // The single terminal check inside the live transition.
  assert.ok(
    store.includes('entry.action === "hold" && Number(entry.bankedTotal) >= WIN_BANKED_SCORE'),
  );
  // The old completion / both-ended settlement paths are gone.
  assert.ok(!store.includes("reason: \"completed\""));
  assert.ok(!store.includes("resolveByFinalScores"));
  assert.ok(!store.includes("advanceTurn"));
});

test("the bot path dedupes wake-ups too", () => {
  assert.ok(aiRoute.includes("actionId"));
  assert.ok(store.includes("hasResolvedActionId(match.actions, actionId)"));
  assert.ok(store.includes("if (actionId) entry.actionId = String(actionId);"));
});

test("the act route forwards actionId + round and treats a duplicate as success", () => {
  assert.ok(actRoute.includes("const actionId = body?.actionId ?? null;"));
  assert.ok(actRoute.includes("const round = body?.round ?? null;"));
  assert.ok(actRoute.includes("if (result.duplicate)"));
  assert.ok(actRoute.includes("duplicate: true"));
});

// ════════════════════════════════════════════════════════════════════
// Scoreboard feedback (score / run-streak / unbanked / banked / progress)
// Presentation only — every figure is derived from state the server
// already sends, and every animation is a one-shot keyed on the VALUE
// (so polling, WebSocket pushes and re-renders cannot replay it).
// ════════════════════════════════════════════════════════════════════

test("every scoreboard figure uses the shared, value-keyed one-shot cue", () => {
  // One module-level helper, reusing the app-wide `animate-state-in`
  // utility (globals.css) instead of a new animation or library.
  assert.ok(page.includes('function ScoreNumber({ value, className = "" })'));
  assert.ok(page.includes("key={shown}"), "the key IS the value");
  assert.ok(page.includes("animate-state-in tabular-nums"));
  const helperAt = page.indexOf("function ScoreNumber(");
  assert.ok(helperAt > 0);
  assert.ok(helperAt < page.indexOf("function DuelTower("), "module-level");
  // Same value => same key => same element => nothing replays, and a
  // rapid run of changes restarts from the newest value (no stacking).
  assert.ok(!/framer-motion\//.test(page), "no extra motion package");
  assert.equal((page.match(/from "framer-motion"/g) || []).length, 1);
});

test("score, at-risk and banked figures are all keyed transitions", () => {
  assert.ok(page.includes("<ScoreNumber value={myScore} />"));
  assert.ok(page.includes("<ScoreNumber value={oppScore} />"));
  assert.ok(page.includes("<ScoreNumber\n                    value={myUnbanked}"));
  assert.ok(page.includes("<ScoreNumber value={oppUnbanked} />"));
  assert.ok(page.includes("<ScoreNumber value={oppBanked}"));
  // The at-risk figure reads red only while a NEW bust is the seat's
  // latest RESOLVED action, so a bust is visible WITHOUT touching banked
  // points — and it stops shouting the moment the seat plays on.
  assert.ok(page.includes('${myBustIsCurrent ? "text-red-300" : "text-rose-200"}'));
  // The protected total keeps its existing one-shot bank emphasis.
  assert.ok(
    pageFlat.includes(
      "animate={ bankConfirm && !shouldReduce ? BANK_BADGE_FLASH : undefined }",
    ),
  );
});

test("the run/streak chip is derived, gated and keyed on its length", () => {
  // Consecutive safe resolutions since the last bust — read-only, from
  // the immutable history, so a poll/refresh always yields the same run.
  assert.ok(page.includes("function safeRunFor(actions, seat)"));
  assert.ok(page.includes("if (a.action === \"hold\") continue;"));
  assert.ok(page.includes("const myRun = useMemo("));
  assert.ok(page.includes("myRun >= 2 &&"), "a single pick is not a streak");
  assert.ok(page.includes("my-run-${myRun}"), "keyed so it pops once per pick");
  // Display-only: this helper never reaches scoring or settlement.
  assert.ok(!store.includes("safeRunFor"), "the store must never see it");
  assert.ok(!page.includes("myScore = myRun"));
});

test("progress meters show banked vs at-risk toward the win target", () => {
  assert.ok(page.includes("function ScoreProgress({"));
  assert.ok(page.includes('tone = "cyan",'));
  assert.ok(page.includes("reached = false,"), "the target crossing is a prop");
  assert.ok(page.includes("bg-amber-400 transition-all duration-300"), "amber = banked");
  assert.ok(page.includes("100 - bankedPct"), "at-risk rides on top of banked");
  assert.ok(page.includes("reached={myBanked >= WIN_BANKED_SCORE}"));
  assert.ok(page.includes("reached={oppBanked >= WIN_BANKED_SCORE}"));
  assert.ok(/tone="cyan"\s*reached=/.test(page), "the viewer's meter is the loud one");
  assert.ok(
    /tone="rose"\s*muted\s*reached=/.test(page),
    "the opponent's meter mirrors the shape, muted",
  );
});

test("the scoreboard never pulses — no looping animation on any figure", () => {
  const board = page.slice(
    page.indexOf("const creatorScoreboard ="),
    page.indexOf("const creatorPressure ="),
  );
  assert.ok(board.length > 0);
  assert.ok(!board.includes("repeat"), "no repeating animation");
  assert.ok(!board.includes("Infinity"));
  assert.ok(!board.includes("animate-pulse"));
  // Width transitions only (a transition is not a loop).
  assert.ok(page.includes("transition-all duration-300"));
});

test("the opponent's readout stays visually secondary", () => {
  assert.ok(page.includes("text-xl font-black text-rose-200/90"), "smaller score type");
  assert.ok(/tone="rose"\s*muted/.test(page));
  // Only the local player's card carries the run chip.
  assert.equal((page.match(/key={`my-run-/g) || []).length, 1);
});

test("reduced motion keeps every scoreboard figure readable", () => {
  // The figures lean on the one shared cue, whose 180ms one-shot the
  // global prefers-reduced-motion block collapses to its end state.
  const globals = read("src/app/globals.css");
  assert.ok(globals.includes(".animate-state-in"));
  assert.ok(globals.includes("animation-duration: 0.01ms !important"));
  assert.ok(page.includes('window.matchMedia?.("(prefers-reduced-motion: reduce)")'));
});

// ════════════════════════════════════════════════════════════════════
// Opponent / AI feedback
// Presentation only. The opponent acts at the same time as the viewer, so
// every cue is EVENT-shaped and keyed on the authoritative action — never
// on a poll, and never on a fabricated "thinking" state.
// ════════════════════════════════════════════════════════════════════

test("the opponent's resolved picks are drawn on the shared board", () => {
  // The tower is shared, so the other seat's survived tile is a public
  // deduction marker (the tracker already trims the candidate count with
  // it — this only makes the deduction legible).
  assert.ok(page.includes("intelPathByLane={myHistory.oppPath}"));
  assert.ok(page.includes("intelPickedByLane={myHistory.oppPicked}"));
  assert.ok(
    !page.includes("intelPathByLane={undefined}"),
    "the opponent intel must actually be wired",
  );
  assert.ok(page.includes("oppPath[key] = a.path;"));
  assert.ok(page.includes("oppPicked[key] = a.tile;"));
  // Different path on the row -> a one-line badge; same path -> a dashed
  // tile marker. Both restrained, neither is a banner.
  assert.ok(page.includes("const tileIsIntel ="));
  assert.ok(page.includes("border-2 border-dashed border-rose-300/70"));
  assert.ok(page.includes('tile{" "}'));
});

test("an opponent bust keeps its marker and says what it cost", () => {
  assert.ok(page.includes("oppBustByLane={oppBustByLane}"));
  // The figure comes from replaying the immutable history, so a refresh
  // can never change it.
  assert.ok(page.includes("Number(oppBust.lost) > 0"));
  assert.ok(page.includes("−{Number(oppBust.lost).toLocaleString()}"));
  // It describes the OPPONENT's run — never the viewer's.
  assert.ok(page.includes("their banked points are safe"));
  assert.ok(page.includes('{isMine ? "Opp" : "You"} busted'));
});

test("the opponent's latest action is announced once, keyed on its identity", () => {
  // One shared identity helper for BOTH seats' latest resolved action, so
  // the announce cue and the viewer's own outcome cue can never disagree on
  // what "the same action" means.
  assert.ok(page.includes("const actionKeyOf = (a) =>"));
  assert.ok(page.includes("const oppActionKey = actionKeyOf(oppLastAction);"));
  assert.ok(page.includes("const myActionKey = actionKeyOf(myLastResolvedAction);"));
  assert.ok(page.includes("function oppNoticeFor(action, actions)"));
  assert.ok(page.includes("const oppLastAction = useMemo("));
  assert.ok(
    page.includes(
      "setOppNotice({ key: oppActionKey, tone: notice.tone, text: notice.text })",
    ),
  );
  assert.ok(page.includes("key={oppNotice.key}"), "one-shot per action identity");
  // The shared state-change cue, so the global reduced-motion rule
  // collapses it and no new animation utility is pulled in.
  assert.ok(
    page.includes("animate-state-in inline-block max-w-full rounded"),
  );
  // …and it WRAPS rather than ellipsising: on a 320px phone the opponent
  // card leaves ~116px, which used to cut the message mid-word (and hide
  // how much the bust cost).
  assert.ok(
    !page.includes("max-w-full truncate rounded"),
    "the announcement must not be truncated away on a narrow card",
  );
  assert.ok(page.includes("py-0.5 text-center leading-tight"));
  // A peek stays a peek: the server withholds the tile and the answer, so
  // the notice may only ever name the LEVEL.
  assert.ok(page.includes('{ tone: "peek", text: `Scouted level ${level}` }'));
  // Every tone is the opponent's colour family, not the viewer's.
  assert.ok(page.includes("const OPP_NOTICE_TONE = {"));
});

test("polling/socket re-deliveries can't replay an opponent action", () => {
  // The action's own identity is the dedup key…
  assert.ok(page.includes("oppActionKey === oppSeenKeyRef.current"));
  // …the first snapshot of the mount is a baseline, not news…
  assert.ok(page.includes("if (!oppPrimedRef.current)"));
  assert.ok(page.includes("oppSeenKeyRef.current = oppActionKey;"));
  // …and a stale timer can't clear newer feedback (rapid actions just
  // replace each other).
  assert.ok(
    page.includes("setOppNotice((cur) => (cur && cur.key === oppActionKey ? null : cur));"),
  );
  // Client-local, short-lived state — cleaned up on unmount AND on a new
  // match, so no stray timer can outlive the duel it belongs to.
  assert.ok(page.includes("const [oppNotice, setOppNotice] = useState(null);"));
  assert.ok(page.includes("}, 2200);"));
  assert.equal(
    (page.match(/clearTimeout\(oppNoticeTimerRef\.current\)/g) || []).length,
    3,
  );
  // Never armed from the status poll.
  const fetchBody = page.slice(
    page.indexOf("const fetchStatus = useCallback"),
    page.indexOf('const finished = match?.status === "finished";'),
  );
  assert.ok(fetchBody.length > 0);
  assert.ok(!fetchBody.includes("setOppNotice"), "a poll must not announce");
  assert.ok(!fetchBody.includes("oppNoticeFor"));
});

test("no fabricated opponent waiting state is added", () => {
  // Mid-match the payload carries no per-seat "deciding" state — the
  // legacy pending flags only describe an entry parked by the old engine
  // and the deadline is scrubbed while no seat owns a turn — so nothing
  // may fake one.
  assert.ok(!page.includes("myPending"), "the legacy flag must not drive UI");
  assert.ok(!page.includes("match?.oppPending"));
  assert.ok(!page.includes("animate-spin"), "no fake spinner");
  assert.ok(!page.includes("OpponentThinking"));
  // Real state is shown instead: the opponent's level and live run.
  assert.ok(page.includes("Level {oppLaneLabel}"));
  assert.ok(page.includes("const oppRun = useMemo("));
});

test("the opponent notice slot is a sibling, never nested in a <p>", () => {
  // A <p> inside a <p> is invalid HTML: the server-rendered string would be
  // re-parsed (closing the outer <p> early) and hydration would mismatch.
  const board = page.slice(
    page.indexOf("const creatorScoreboard ="),
    page.indexOf("const creatorPressure ="),
  );
  assert.ok(board.length > 0);
  assert.equal(
    (board.match(/<p\b/g) || []).length,
    (board.match(/<\/p>/g) || []).length,
    "every scoreboard <p> must close exactly once",
  );
  const slotAt = board.indexOf('className="mt-0.5 flex min-h-[18px]');
  const slotClose = board.indexOf("</p>", slotAt);
  const atRiskAt = board.indexOf("At risk ", slotClose);
  assert.ok(slotAt > -1 && slotClose > slotAt && atRiskAt > slotClose);
});

test("opponent safe / bank / bust get distinct, restrained audio cues", () => {
  const audio = read("src/lib/gameAudio.ts");
  for (const fn of [
    "playOpponentPick",
    "playOpponentBank",
    "playOpponentBust",
  ]) {
    assert.ok(audio.includes(`export function ${fn}()`), `${fn} must exist`);
  }
  // The rival's own family: a dull triangle timbre, never the player's
  // bright sine / harsh square.
  const cueBlock = audio.slice(audio.indexOf("// ── Opponent cues"));
  assert.ok(cueBlock.length > 0);
  const cueCalls = cueBlock.match(/playTone\([^)]*\)/g) || [];
  assert.equal(cueCalls.length, 6, "three two-tone cues");
  assert.ok(cueCalls.every((c) => c.includes('"triangle"')));
  // …and quieter than the player's own: every opponent cue stays at or
  // below 0.05 while the player's own go to 0.1.
  const volumes = [...cueBlock.matchAll(/, 0\.(\d+)\)/g)].map((m) =>
    Number(`0.${m[1]}`),
  );
  assert.equal(volumes.length, 6);
  assert.ok(volumes.every((v) => v <= 0.05), "opponent cues stay restrained");
  // The visible notice's tone is the single source of which cue fires, so
  // audio and picture can never disagree.
  assert.ok(page.includes('if (notice.tone === "bust") playOpponentBust();'));
  assert.ok(page.includes('else if (notice.tone === "bank") playOpponentBank();'));
  assert.ok(page.includes('else if (notice.tone === "safe") playOpponentPick();'));
  // A peek is information, not a play — it stays silent.
  assert.ok(!page.includes("playOpponentPeek"));
  assert.ok(!page.includes('notice.tone === "peek") play'));
  // The viewer's own cues are untouched.
  assert.ok(page.includes("playGoodReveal()"));
  assert.ok(page.includes("playBuzz()"));
  assert.ok(page.includes("playVictory()"));
  // Mute stays centralised: the cues route through the shared context
  // (gameAudio only), so the global gate silences them like every other.
  assert.ok(audio.includes("getSharedAudioContext"));
});

test("the viewer's own pick / safe / bank each get exactly one cue", () => {
  const audio = read("src/lib/gameAudio.ts");
  // The viewer's own bright sine family, sitting above the dull opponent
  // triangle family — the audio mirrors the visual hierarchy.
  const own = audio.slice(
    audio.indexOf("// ── Player's own gameplay cues"),
    audio.indexOf("// ── Opponent cues"),
  );
  assert.ok(own.length > 0, "the player cue block must exist");
  for (const fn of ["playSelect", "playSafePick", "playBank"]) {
    assert.ok(own.includes(`export function ${fn}()`), `${fn} must exist`);
  }
  // Distinct gesture per event, and never the rival's dull triangle alone.
  assert.ok(own.includes('playTone(520, 0.05, "sine"'));
  assert.ok(own.includes('playTone(587, 0.08, "sine"'));
  assert.ok(own.includes('playTone(440, 0.09, "sine"'));
  const ownVols = [...own.matchAll(/, 0\.(\d+)\)/g)].map((m) =>
    Number(`0.${m[1]}`),
  );
  assert.ok(ownVols.length >= 3);
  // Louder than the rival's (<=0.05) — your play is the primary signal.
  assert.ok(ownVols.some((v) => v > 0.05));

  // ── Exactly-once wiring ────────────────────────────────────────────
  const calls = (name) => (page.match(new RegExp(`\\b${name}\\(`, "g")) || []).length;
  assert.equal(calls("playSelect"), 1, "the press cue fires exactly once");
  assert.equal(calls("playSafePick"), 1, "the safe cue fires exactly once");
  assert.equal(calls("playBank"), 1, "the bank cue fires exactly once");

  // The press cue belongs to the GESTURE, inside doAction, and only after
  // the refusal guards — a duplicate tap or a re-pick of an already-busted
  // tile must stay silent. It must never claim the outcome.
  const selectAt = page.indexOf("playSelect()");
  const doActionAt = page.indexOf("const doAction = useCallback(");
  const guardAt = page.indexOf("action === \"pick\" &&", doActionAt);
  const pendingAt = page.indexOf("setPendingTile({ lane: clickedLane", doActionAt);
  assert.ok(selectAt > doActionAt && selectAt < pendingAt);
  assert.ok(guardAt > -1 && guardAt < selectAt, "refused taps stay silent");
  assert.ok(
    !page.slice(doActionAt, page.indexOf("const cancelLobby")).includes("playSafePick"),
    "the POST must never claim a result",
  );

  // The OUTCOME cue is keyed on the action's own identity and baselined on
  // the first authoritative snapshot, so broadcast + 5s poll + socket
  // re-push + Strict-Mode double effects + reload all collapse to one cue.
  assert.ok(page.includes("const myActionKey = actionKeyOf(myLastResolvedAction);"));
  assert.ok(page.includes("mySeenKeyRef.current = myActionKey;"));
  assert.ok(page.includes("myPrimedRef.current = true;"));
  assert.ok(
    page.includes("if (!myActionKey || myActionKey === mySeenKeyRef.current) return;"),
  );
  // A hold banks, a surviving pick/flag confirms, and nothing else speaks —
  // so a bust keeps its own keyed buzz and a peek keeps its reveal cue.
  assert.ok(page.includes('if (a.action === "hold") playBank();'));
  assert.ok(page.includes('a.safe === true && (a.action === "pick" || a.action === "flag")'));
  assert.ok(!page.includes('=== "bust") playSafePick'));
  assert.ok(!page.includes('=== "peek") playSafePick'));
  // Rematch re-arms both baselines instead of swallowing the new duel.
  assert.ok(page.includes("mySeenKeyRef.current = null;"));
  assert.ok(page.includes("myPrimedRef.current = false;"));

  // Mute / volume / autoplay stay centralised: the page never builds its
  // own context, so the global gate silences every cue at once.
  assert.ok(!page.includes("new AudioContext"));
  assert.ok(!page.includes("createOscillator"));
  assert.ok(audio.includes("getSharedAudioContext"));
});

test("an opponent peek shows the level they are scouting, level only", () => {
  assert.ok(page.includes("const oppScoutingLevel ="));
  // "Active" is derived from published facts: their NEWEST resolved action
  // is a peek and it targeted the row they are still standing on.
  assert.ok(page.includes('oppLastAction?.action === "peek"'));
  assert.ok(page.includes("oppPeekRow === oppLane"));
  assert.ok(page.includes("oppLastAction?.round ?? oppLastAction?.lane"));
  // Rendered as a scouting chip, falling back to their plain level.
  assert.ok(page.includes("Scouting L{oppScoutingLevel}"));
  assert.ok(page.includes("<IconEye size={9} />"));
  assert.ok(page.includes("<>Level {oppLaneLabel}</>"));
  // The withheld facts are never read for the opponent: the server sends
  // only the level, so no position or answer can leak in.
  assert.ok(!page.includes("oppLastAction.peekResult"));
  assert.ok(!page.includes("oppLastAction.tile"));
  assert.ok(!page.includes("oppLastAction.path"));
});

test("the opponent read-outs never feed scoring or settlement", () => {
  assert.ok(!store.includes("oppNoticeFor"));
  assert.ok(!store.includes("oppActionKeyOf"));
  assert.ok(!page.includes("oppBanked = oppScore"));
  assert.ok(!page.includes("oppScore = oppBanked"));
  assert.ok(page.includes("const oppUnbanked = Math.max(0, oppScore - oppBanked);"));
});

// ════════════════════════════════════════════════════════════════════
// State transitions — one-shot, keyed, retired by real state
// ════════════════════════════════════════════════════════════════════

test("a bust stops out-ranking the current play once the seat moves on", () => {
  // "Current" is derived from the seat's newest RESOLVED action, so the
  // banner and the red at-risk tone retire on the next real state change
  // instead of narrating the rest of the match.
  assert.ok(page.includes("function lastResolvedActionFor(actions, seat)"));
  assert.ok(
    page.includes('a.action !== "pending"'),
    "a parked (deferred) pick is not an outcome yet",
  );
  assert.ok(page.includes("const myLastResolvedAction = useMemo("));
  assert.ok(page.includes("const myBustIsCurrent ="));
  assert.ok(page.includes("bustKeyOf(myLastResolvedAction) === myBustKey"));
  assert.ok(
    page.includes("{myBustIsCurrent && ("),
    "the bust banner follows the seat's newest action",
  );
  assert.ok(page.includes('${myBustIsCurrent ? "text-red-300" : "text-rose-200"}'));
  assert.ok(
    !page.includes("{myLastBust && ("),
    "no bust banner that outlives the seat's next action",
  );
  // …while the LOSS itself stays on the board permanently (memory).
  assert.ok(page.includes("Bust · −"), "the row badge keeps the loss");
  assert.ok(page.includes("myBustByLane"), "the busted tile keeps its ✕");
  assert.ok(page.includes("latestBustFor(match?.actions, mySeat)"));
  // The buzz still keys on the bust itself: a new bust always speaks, even
  // if it is immediately superseded.
  assert.ok(page.includes("if (lastBustSeenRef.current === myBustKey) return;"));
});

test("a peek result narrates only the row it was spent on", () => {
  assert.ok(page.includes("const myPeekIsCurrent ="));
  assert.ok(page.includes("Number(lastPeek.round) === Number(myLane)"));
  assert.ok(page.includes("{myPeekIsCurrent && !finished && ("));
  assert.ok(page.includes('data-testid="lane-runner-peek-card"'));
  // The ANSWER stays permanent — the peeked tile keeps its ✓/✕ mark and
  // the deduction tracker keeps using it — so retiring the card loses
  // nothing.
  assert.ok(page.includes("tilePeeked"));
  assert.ok(page.includes("myPeeks?.[laneIdx]"));
});

test("the peek reveal is voiced once per peek, never once per poll", () => {
  assert.ok(page.includes("const peekIdOf = (peek) =>"));
  assert.ok(page.includes("round: last.round ?? last.lane,"));
  assert.ok(page.includes("if (lastPeekRef.current === peekIdOf(lastPeek)) return;"));
  assert.ok(page.includes("lastPeekRef.current = peekIdOf(lastPeek);"));
  // …and never once per TILE index, which recurs on later rows.
  assert.ok(!page.includes("lastPeekRef.current.tile === lastPeek.tile"));
  // A RELOAD/reconnect is a baseline, not news: the first authoritative
  // snapshot of a mount records whatever peek the history already carried,
  // so re-opening the page never re-voices a reveal that already sounded
  // (and never voices one that happened before we were watching).
  const baselineAt = page.indexOf("const firstSeat = first?.viewerIsPlayer1");
  assert.ok(baselineAt > -1, "the peek reveal needs a load baseline");
  assert.ok(
    page.includes("lastPeekRef.current = peekIdOf(lastPeekFor(first?.actions, firstSeat));"),
  );
  // …inside the same first-snapshot block that baselines the busts.
  const blockStart = page.indexOf("First snapshot of this mount");
  const block = page.slice(
    blockStart,
    page.indexOf("setError(null);", blockStart),
  );
  assert.ok(block.includes("loadBustKeysRef.current = new Set("));
  assert.ok(block.includes("const firstSeat = first?.viewerIsPlayer1"));
  // The card and the voice read the peek through ONE shared definition, so
  // they can never disagree about which peek the seat is looking at.
  assert.ok(page.includes("function lastPeekFor(actions, seat)"));
  assert.ok(page.includes("const last = lastPeekFor(match?.actions, mySeat);"));
  const revealEffect = page.slice(
    page.indexOf("// Surface the most recent peek result"),
    page.indexOf("// Bad tile per lane per path"),
  );
  assert.ok(revealEffect.includes("const last = lastPeekFor(match?.actions, mySeat);"));
  assert.ok(!revealEffect.includes("peeks.length > 0"));
});

test("a rematch re-arms every piece of feedback", () => {
  const reset = page.slice(
    page.indexOf("A new matchId is a NEW duel"),
    page.indexOf("// ── Status polling"),
  );
  assert.ok(reset.length > 0, "the matchId reset effect must exist");
  for (const ref of [
    "lastBustSeenRef.current = null;",
    "loadBustKeysRef.current = null;",
    "oppSeenKeyRef.current = null;",
    "oppPrimedRef.current = false;",
    "lastPeekRef.current = null;",
    "mySeenKeyRef.current = null;",
    "myPrimedRef.current = false;",
  ]) {
    assert.ok(reset.includes(ref), `${ref} must be cleared for a new duel`);
  }
  for (const setter of [
    "setLastPeek(null);",
    "setPendingTile(null);",
    "setConfirmTile(null);",
    "setBankConfirm(null);",
    "setBankPending(false);",
    "setOppNotice(null);",
  ]) {
    assert.ok(reset.includes(setter), `${setter} must be cleared for a new duel`);
  }
  // The peek-dedup ref is declared BEFORE the reset effect, so a rematch can
  // re-arm it rather than run the reset against an uninitialised ref.
  assert.ok(
    page.indexOf("const lastPeekRef = useRef(null);") <
      page.indexOf("A new matchId is a NEW duel"),
  );
});

test("reaching the 1,000-banked target cues once, then holds still", () => {
  assert.ok(page.includes("reached = false,"));
  assert.ok(page.includes('key={reached ? "reached" : "racing"}'));
  assert.ok(page.includes('reached ? "animate-state-in ring-1 ring-amber-300/70" : ""'));
  assert.ok(page.includes("reached={myBanked >= WIN_BANKED_SCORE}"));
  assert.ok(page.includes("reached={oppBanked >= WIN_BANKED_SCORE}"));
  // One-shot only: the meter never loops.
  const at = page.indexOf('key={reached ? "reached"');
  const meter = page.slice(at, at + 700);
  assert.ok(at > 0 && !/animate-pulse|Infinity|repeat/.test(meter));
});

test("no control carries a permanent animation", () => {
  // The bank button used to breathe forever (repeat: Infinity) while the
  // player could bank — a permanent pulse competing with every real
  // transition. It now carries a one-shot cue on the bankable amount.
  assert.ok(!page.includes("Infinity"), "no infinite animation targets");
  assert.ok(!page.includes("animate-pulse"), "no pulsing elements");
  assert.ok(page.includes("const BANK_PRESS_TRANSITION ="));
  assert.ok(pageFlat.includes("transition={ shouldReduce ? undefined : BANK_PRESS_TRANSITION }"));
  assert.ok(page.includes("key={`bank-label-${myScore}`}"));
  // The only remaining looping mark is the REAL waiting state (matchmaking),
  // which is not a gameplay transition.
  const pings = page.match(/animate-ping/g) || [];
  assert.equal(pings.length, 1);
});

// ════════════════════════════════════════════════════════════════════
// The result experience (shared PvpResultScreen)
// Presentation only: the outcome, the score, the payout and the winner are
// the settled server values — the page only chooses how they are told.
// ════════════════════════════════════════════════════════════════════

test("the result screen is mounted exactly once, and sized per frame", () => {
  // It used to be mounted twice in normal play (once at page level, once in
  // the desktop branch), which doubled the overlay AND the win confetti.
  assert.equal((page.match(/\{matchEndPopup\}/g) || []).length, 1);
  assert.equal((page.match(/\{matchEndPopupCompact\}/g) || []).length, 1);
  assert.ok(
    !page.includes("      {matchEndPopup}\n      <NavigationBar"),
    "no page-level duplicate mount",
  );
  // One shared props object, built only for a settled match (`finished`
  // implies `match`, so nothing can read a half-loaded payload).
  assert.ok(page.includes("const resultScreenProps = finished ? {"));
  assert.ok(page.includes("<PvpResultScreen open {...resultScreenProps} />"));
  assert.ok(
    page.includes("<PvpResultScreen open compact {...resultScreenProps} />"),
    "the creator phone frame gets the compact panel",
  );
  assert.equal(
    (page.match(/<PvpResultScreen/g) || []).length,
    2,
    "exactly two mounts (normal + compact)",
  );
  assert.ok(
    page.includes("{matchEndPopupCompact}\n    </CreatorModeShell>"),
    "…and the compact one is the portrait shell's",
  );
});

test("the result still reads its outcome, score and payout from the server", () => {
  assert.ok(page.includes('outcome: drawMatch ? "draw" : wonMatch ? "win" : "loss",'));
  // Untouched settlement math.
  assert.ok(/\? Number\(match\.prizePaid \|\| 0\) - stakeNumber/.test(page));
  assert.ok(page.includes(": -stakeNumber,"));
  assert.ok(page.includes("const wonMatch = finished && match.winnerId === user?.id;"));
  // The page never ASSIGNS a winner (it only compares) — the server decides.
  assert.ok(!/\bwinnerId\s*=\s*[^=]/.test(page));
  assert.ok(!/\bresult\s*=\s*[^=]/.test(page));
  assert.ok(!store.includes("wasResigned"));
  assert.ok(!store.includes("FinalRaceReadout"));
  assert.ok(!store.includes("resultScreenProps"));
});

test("the reason for the result comes from published state only", () => {
  assert.ok(page.includes("const wasResigned = (actions) =>"));
  assert.ok(page.includes('a === "resign" || (a && a.action === "resign")'));
  assert.ok(page.includes("const resignedEnd = wasResigned(match?.actions);"));
  // Both existing end-states are named, and a resignation is never sold as a
  // target win.
  assert.ok(page.includes('? "Opponent resigned — the pot is yours"'));
  assert.ok(page.includes('? "You resigned — the pot went to your opponent"'));
  assert.ok(page.includes("`They banked ${Number(oppBanked).toLocaleString()} first`"));
  assert.ok(page.includes('? "Resignation"'));
  assert.ok(page.includes('{ label: "Won by", value: wonBy }'));
  // …and it never invents a marker the server doesn't publish.
  assert.ok(!page.includes("resignedBy"));
  assert.ok(!page.includes("endReason"));
});

test("the final-score comparison keeps the winner hierarchy", () => {
  assert.ok(page.includes("sides: ["));
  assert.ok(
    page.includes(
      '{ name: "You", score: myFinalPts, highlight: !drawMatch && wonMatch },',
    ),
  );
  assert.ok(
    page.includes(
      '{ name: oppDisplayName, score: oppFinalPts, highlight: !drawMatch && !wonMatch },',
    ),
  );
  // The old flat "Final score" row is gone — the comparison replaces it.
  assert.ok(!page.includes('label: "Final score"'));
  assert.ok(!page.includes("summary={"));
});

test("the final-race read-out explains the result in the game's own terms", () => {
  assert.ok(page.includes("function FinalRaceReadout({"));
  assert.ok(page.includes('data-testid="lane-runner-final-race"'));
  assert.ok(
    page.includes("Final race · first to {WIN_BANKED_SCORE.toLocaleString()} banked"),
  );
  // Reuses the identical meter the player watched all match.
  assert.ok(/<ScoreProgress\s+banked=\{r\.banked\}/.test(page));
  assert.ok(page.includes("reached={Number(r.banked) >= WIN_BANKED_SCORE}") || page.includes("const reached = Number(r.banked) >= WIN_BANKED_SCORE;"));
  // Static: the shared panel sequences its own entrance, so the read-out
  // adds no motion of its own (and nothing that could loop).
  const at = page.indexOf("function FinalRaceReadout({");
  const readout = page.slice(at, at + 2600);
  assert.ok(at > 0);
  assert.ok(!/motion\./.test(readout), "no competing animation system here");
  assert.ok(!/repeat|Infinity|animate-pulse|animate-ping/.test(readout));
});

test("every state-transition one-shot stays inside the timing guidance", () => {
  const durations = [...page.matchAll(/duration:\s*([0-9.]+)/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(durations.length >= 7, "expected the one-shot constants to exist");
  assert.ok(
    durations.every((d) => d >= 0.1),
    `nothing faster than a 100ms flicker: ${durations}`,
  );
  assert.ok(
    durations.every((d) => d <= 0.7),
    `nothing longer than the 700ms major-result ceiling: ${durations}`,
  );
  // One motion library, no new one.
  assert.equal((page.match(/from "framer-motion"/g) || []).length, 1);
});

// ════════════════════════════════════════════════════════════════════
// Reduced motion + accessibility
// ════════════════════════════════════════════════════════════════════

test("every framer movement opts out under reduced motion, via the shared system", () => {
  // The repo's system, not a new one: framer's own media hook plus the
  // shared static variant. This matters because the global CSS rule in
  // globals.css can ONLY collapse CSS animation/transition — JS-driven
  // (framer) movement keeps running unless it opts out here, so without
  // these guards "reduce" would silently leave the biggest movements on.
  assert.ok(
    page.includes('import { motion, useReducedMotion } from "framer-motion";'),
  );
  assert.ok(
    page.includes('import { withReducedMotion } from "../../../../lib/animations";'),
  );
  // The tower and the page each hold their own switch.
  assert.equal((page.match(/useReducedMotion\(\)/g) || []).length, 2);
  // The two one-shot ENTRANCES use the shared swap.
  assert.equal((page.match(/withReducedMotion\(shouldReduce, /g) || []).length, 2);
  assert.ok(
    pageFlat.includes("{...withReducedMotion(shouldReduce, BUST_BANNER_ONESHOT)}"),
  );
  assert.ok(pageFlat.includes("{...withReducedMotion(shouldReduce, BANK_ONESHOT)}"));
  assert.ok(
    pageFlat.includes("initial={shouldReduce ? false : { opacity: 0, y: 10 }}"),
    "the waiting/ready entrance must not slide in either",
  );
  // Every scale/rise target is gated — the row arrival, both tile pops and
  // their transitions, the banked-total flash, and both press scales.
  const gates = [
    "animate={isCurrent && !shouldReduce ? ROW_LIVE_ONESHOT : undefined}",
    "transition={ isCurrent && !shouldReduce ? ROW_LIVE_TRANSITION : undefined }",
    "whileHover={ tileCanPick && !shouldReduce ? { scale: 1.04 } : undefined }",
    "whileTap={ tileCanPick && !shouldReduce ? { scale: 0.96 } : undefined }",
    "shouldReduce ? undefined : tileIsMyBust ? BUST_TILE_FLASH",
    "shouldReduce ? undefined : tileIsMyBust ? BUST_TILE_TRANSITION",
    "animate={ bankConfirm && !shouldReduce ? BANK_BADGE_FLASH : undefined }",
    "transition={ bankConfirm && !shouldReduce ? BANK_BADGE_TRANSITION : undefined }",
    "whileTap={ canHold && !bankPending && !shouldReduce ? { scale: 0.97 } : undefined }",
    "transition={ shouldReduce ? undefined : BANK_PRESS_TRANSITION }",
  ];
  for (const gate of gates) {
    assert.ok(pageFlat.includes(gate), `not reduced-motion aware: ${gate}`);
  }
  // No screen shake, and nothing that loops.
  assert.ok(!/shake/i.test(page));
  assert.ok(!page.includes("animate-pulse"));
  assert.ok(!page.includes("Infinity"));
  // The only CSS animations left are the shared one-shot cue and the dot on
  // the REAL waiting state; both are collapsed by the global rule.
  const cssAnims = [...new Set(page.match(/animate-[a-z-]+/g) || [])].sort();
  assert.deepEqual(cssAnims, ["animate-ping", "animate-state-in"]);
});

test("motion off still leaves every state readable (nothing is motion-only)", () => {
  // The guards above may only drop the animation TARGET. The colour, the
  // glyph and the copy that carry the meaning are unconditional state, so
  // a reduced-motion player still sees exactly what happened.
  assert.ok(!page.includes('shouldReduce ? ""'));
  const tileBlock = page.slice(
    page.indexOf("const tileCanPick ="),
    page.indexOf("</motion.button>"),
  );
  assert.ok(tileBlock.length > 0);
  // Bust: red fill + ✕ glyph + the figure it cost, all static.
  assert.ok(tileBlock.includes("from-red-600 to-rose-900"));
  assert.ok(tileBlock.includes("aria-hidden>✕</span>"));
  assert.ok(tileBlock.includes("−{bustLoss.toLocaleString()}"));
  // Safe: an emerald ring (not just the scale pop) + ✓ + a distinct label.
  assert.ok(tileBlock.includes("ring-2 ring-emerald-200/90"));
  assert.ok(tileBlock.includes('glyph = "✓";'));
  // Each state's accessible name is written from the state itself.
  assert.ok(tileBlock.includes("unbanked points lost"));
  assert.ok(tileBlock.includes("your banked points are safe"));
  assert.ok(tileBlock.includes("peeked: BAD tile, only you can see this"));
  assert.ok(tileBlock.includes("not available on this level"));
  // The bust banner and the bank strip carry their news as TEXT in a live
  // region, so the entrance is never the message.
  assert.ok(page.includes("That red tile took your at-risk run."));
  assert.ok(page.includes("is safe and the duel"));
  assert.ok(page.includes("+{bankConfirm.moved.toLocaleString()}"));
  assert.ok(page.includes("and bust-proof. Keep climbing."));
  // The progress meter is a plain CSS width transition (collapsed by the
  // global rule), never a JS-driven movement.
  const m = page.slice(page.indexOf("function ScoreProgress({"));
  assert.ok(m.includes("transition-"));
  assert.ok(!/motion\./.test(m.slice(0, m.indexOf("function FinalRaceReadout"))));
});

test("interactive controls are keyboard reachable with a visible focus ring", () => {
  // Every control that opts out of the browser outline must supply its own
  // visible ring — killing the outline without a replacement is the classic
  // "keyboard user has no idea where they are" bug.
  const outlined = (page.match(/focus-visible:outline-none/g) || []).length;
  const ringed = (page.match(/focus-visible:ring-2/g) || []).length;
  assert.equal(outlined, ringed);
  assert.ok(ringed >= 10, `expected every control to be ringed, got ${ringed}`);
  // The board's tiles are real buttons (not clickable divs) and are named.
  assert.ok(page.includes("<motion.button"));
  assert.ok(page.includes("aria-label={`Level ${laneIdx + 1} tile ${tileIdx + 1}"));
  // Mode + odds choices expose their state, not just their colour.
  assert.equal((page.match(/aria-pressed=/g) || []).length, 3);
  assert.ok(page.includes("aria-pressed={peekMode}"));
  assert.ok(page.includes("aria-pressed={flagMode}"));
  assert.ok(page.includes("aria-pressed={selectedPath === path.key}"));
  // Tap targets: tiles keep their 48px/56px hitbox and the odds chips get a
  // 44px minimum, so nothing on the board is a sub-24px target.
  assert.ok(page.includes("min-h-[48px]"));
  assert.ok(page.includes("sm:min-h-[56px]"));
  assert.ok(page.includes("min-h-[44px] rounded-xl border px-2 py-2 text-center"));
  // …and the four live regions are still there for a screen reader.
  assert.equal((page.match(/role="status"/g) || []).length, 3);
  assert.equal((page.match(/aria-live="polite"/g) || []).length, 3);
});
