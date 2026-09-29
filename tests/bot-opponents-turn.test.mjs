// Bot-opponent turn-taking contract.
//
// Every game that ships a practice bot has to answer one question: what
// actually makes the bot move? A bot woken only by a request the client never
// sends — or one the server refuses because it arrived outside the bot's own
// think window — is a bot that "does nothing" while the human stares at a
// frozen board. That is exactly the Keno bug: a 200–420ms server-side reaction
// window probed only by a 5s poll and a post-deadline nudge, so every tile
// both-missed.
//
// There are three valid shapes of wiring, and each game below has to pick one
// and be internally consistent about it:
//   • client-driven — the page must POST the bot's turn itself, and must
//     retry/resync when that POST does not land (Keno, Mines, Lane Rush);
//   • think-window games — the client's ask has to land AFTER the server's
//     window or the server rejects it (Tower Arena, Keno);
//   • poll-driven — the read route itself advances the bot, so a client poll
//     is enough (Tower Arena's poll backstop).
//
// The assertions read the real sources rather than running a DB, matching the
// existing per-game contract suites (keno-pvp-survival, lane-rush-duel-ui,
// dice-flush-route-contract).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Normalise CRLF so the structural assertions behave the same on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const num = (raw) => Number(String(raw).replace(/_/g, ""));

const towerPage = read("src/app/casino/tower-arena/game/[matchId]/PageClient.tsx");
const towerStore = read("src/lib/tower-arena/serverStore.ts");
const towerResolver = read("src/lib/tower-arena/turnResolver.ts");
const towerRoute = read("src/app/api/tower-arena/ai-turn/route.ts");
const towerGetMatch = read("src/app/api/tower-arena/get-match/route.ts");

// ── Tower Arena ───────────────────────────────────────────────────────

test("tower arena: the page's ask lands after the server's think window", () => {
  const planDelay = num(
    towerPage.match(/const BOT_PLAN_DELAY_MS = ([\d_]+);/)?.[1],
  );
  const thinkMs = num(towerResolver.match(/export const BOT_THINK_MS = ([\d_]+);/)?.[1]);
  assert.ok(Number.isFinite(planDelay) && Number.isFinite(thinkMs));
  assert.ok(
    planDelay > thinkMs,
    `the ask (${planDelay}ms) must land after the bot's window (${thinkMs}ms) or the server refuses it`,
  );

  // The refusal is real, which is what makes the ordering above load-bearing.
  assert.ok(
    towerStore.includes('if (dl > Date.now()) return { error: "Bot is still planning its placement", status: 409 };'),
    "the server still rejects an ask that arrives inside the bot's window",
  );

  // The page only asks while a bot actually holds the turn, once per turn.
  const start = towerPage.indexOf("AI turns: when a bot holds the placement turn");
  assert.ok(start > 0, "the page must carry a bot-turn effect");
  const body = towerPage.slice(start, start + 1600);
  assert.ok(body.includes("holder?.isAi"), "only a bot's turn is woken");
  assert.ok(body.includes("match.phase !== \"placement\""), "only during placement");
  assert.ok(
    body.includes("aiTurnFiredTurn.current === match.turnNumber"),
    "one ask per turn number, so a re-render cannot spam the route",
  );
  assert.ok(body.includes('void fetch("/api/tower-arena/ai-turn"'));
  assert.ok(body.includes("}, BOT_PLAN_DELAY_MS);"), "the ask is scheduled, not fired inline");

  // The route reads matchId from the JSON body the page sends — a query-param
  // mismatch would 400 silently and hand every turn to the poll backstop.
  assert.ok(towerRoute.includes("const { matchId } = await req.json()"));
  assert.ok(body.includes("JSON.stringify({ matchId })"));
});

test("tower arena: a 3s poll resolves a bot turn even if the ask is lost", () => {
  assert.ok(
    towerGetMatch.includes("await advanceMatchOnPoll(String(matchId), userId);"),
    "the read route must run the poll-driven advance",
  );
  const start = towerStore.indexOf("export async function advanceMatchOnPoll");
  const body = towerStore.slice(start, towerStore.indexOf("export function safeFallbackPlacement"));
  assert.ok(
    body.includes("(deadlineMs > 0 && deadlineMs <= now) || (botTurn && deadlineMs <= 0)"),
    "an expired bot window must count as expired",
  );
  assert.ok(
    body.includes('actionType: botTurn ? "AI" : "TIMEOUT"'),
    "the poll must resolve a bot's turn as an AI placement",
  );
  assert.ok(
    body.includes("if (!botTurn && Boolean(match.isAi)) return { match };"),
    "a free vs-AI match must still let the bot move (only the human's turn is untimed)",
  );
});

// ── Sweep: every gated bot must have a client ask that clears the gate ──

test("every bot whose turn is gated by the server has a client ask that clears the gate", () => {
  // Keno — a 200–420ms reaction band. The fixed-delay probe burst has to span
  // the whole band so the bot's claim lands while the player is watching that
  // tile: the store grades the bot's tap at its OWN instant (so a late ask no
  // longer loses the tile), but without the burst the claim only appears on the
  // next 5s poll — after the tile has expired and a both-miss resolved.
  const kenoEngine = read("src/lib/keno-pvp/engine.js");
  const kenoPage = read("src/app/casino/keno-pvp/[matchId]/PageClient.jsx");
  const minReaction = num(kenoEngine.match(/const AI_MIN_REACTION_MS = ([\d_]+);/)?.[1]);
  const jitter = num(kenoEngine.match(/const AI_REACTION_JITTER_MS = ([\d_]+);/)?.[1]);
  const ceiling = minReaction + jitter;
  const offsets = (
    kenoPage.match(/const AI_TURN_PROBE_OFFSETS_MS = \[([^\]]+)\]/)?.[1] || ""
  )
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));
  assert.ok(offsets.length >= 3, "keno needs a probe burst, not one ask");
  assert.ok(
    Math.min(...offsets) <= minReaction && Math.max(...offsets) >= ceiling - 1,
    `keno probes [${offsets}] must span the bot's ${minReaction}–${ceiling}ms reaction band`,
  );

  // Mines PvP — turns strictly alternate, so the server gates the bot's turn
  // on the shared turn formula (an ask that arrives out of turn is answered
  // idempotently rather than failing). The page still uses the shared reveal
  // rhythm constant for its own board hold.
  const minesConstants = read("src/lib/mines-pvp/constants.js");
  const minesStore = read("src/lib/mines-pvp/serverStore.js");
  const minesPage = read("src/app/casino/mines-pvp/[matchId]/PageClient.tsx");
  assert.ok(minesConstants.includes("export const AI_PICK_DELAY_MS ="));
  assert.ok(
    minesPage.includes("AI_PICK_DELAY_MS,") &&
      /setTimeout\(resolve, AI_PICK_DELAY_MS\)/.test(minesPage),
    "the page must pace its own reveal rhythm with the shared constant",
  );
  assert.ok(
    minesStore.includes("expectedPicker !== match.player2Id"),
    "the server only plays the bot when the turn formula says it is up",
  );
  assert.ok(
    minesStore.includes("alreadyPlayed: true"),
    "an out-of-turn ask stays success-shaped so the client can just re-ask",
  );

  // Lane Rush Duel — the bot is paced server-side, so ONE ask per state is not
  // enough: a wake-up that lands inside the throttle applies nothing (and still
  // answers success), and a safe tile KEEPS the bot's turn. The page therefore
  // has to keep waking it on the shared interval — a single latched ask leaves
  // the bot frozen until its 15s window times out and resets it to row 1,
  // which is the "the AI does not play" bug.
  const lanePage = read("src/app/casino/lane-runner/[matchId]/PageClient.jsx");
  const laneStore = read("src/lib/lane-rush-duel/serverStore.js");
  const laneConstants = read("src/lib/lane-rush-duel/constants.js");
  assert.ok(laneConstants.includes("export const BOT_ACTION_INTERVAL_MS"));
  assert.ok(laneStore.includes("BOT_ACTION_INTERVAL_MS"), "the throttle lives on the server");
  const laneStart = lanePage.indexOf("Test vs Bot: keep waking the bot while IT owns the turn");
  assert.ok(laneStart > 0);
  const laneBody = lanePage.slice(laneStart, laneStart + 3400);
  assert.ok(laneBody.includes('`/api/lane-rush-duel/match/${matchId}/ai-turn`'));

  // The page paces itself off the SHARED constant (never a private copy), so
  // the client can never wake the bot faster than the server will apply it.
  assert.ok(
    lanePage.includes("BOT_WAKE_INTERVAL_MS = BOT_ACTION_INTERVAL_MS + 150"),
    "the wake-up interval must be derived from the server's own throttle",
  );
  assert.ok(
    laneBody.includes("timer = setTimeout(wake, BOT_WAKE_INTERVAL_MS)"),
    "a throttled ask must re-arm the next wake-up instead of latching",
  );
  assert.ok(
    laneBody.includes("await fetchStatus()"),
    "every answer resyncs, so the next ask decides from the real board",
  );
  // It stops the moment the bot no longer owns the turn (its own fall, a
  // timeout, the duel ending) — read from the LIVE payload, not the closure.
  assert.ok(
    laneBody.includes('if (live.currentTurnUserId !== "AI_BOT") return;') &&
      laneBody.includes("matchRef.current"),
    "the loop re-checks turn ownership against the newest payload",
  );
  // One action per state: the ask is deduped on (match, turn, action count).
  assert.ok(
    laneBody.includes("`${matchId}:bot:${live.currentTurnUserId}:${actionCount}`"),
    "each ask carries the idempotency key the server dedupes on",
  );
  assert.ok(
    !lanePage.includes("botTurnFiredRef"),
    "the one-shot latch that froze the bot must be gone",
  );
});
