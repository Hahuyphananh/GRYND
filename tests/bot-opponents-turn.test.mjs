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
//   • server-driven — the human's read route runs the bot, so any poll is
//     enough (Blackjack);
//   • client-driven — the page must POST the bot's turn itself, and must
//     retry/resync when that POST does not land (Plinko, Keno, Mines, Lane
//     Rush);
//   • think-window games — the client's ask has to land AFTER the server's
//     window or the server rejects it (Tower Arena, Keno).
//
// The assertions read the real sources rather than running a DB, matching the
// existing per-game contract suites (keno-pvp-survival, lane-rush-duel-ui,
// dice-flush-route-contract).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ACTION_TYPE,
  PLAYER_STATE,
  chooseAiAction,
} from "../src/lib/blackjack-pvp/constants.js";

// Normalise CRLF so the structural assertions behave the same on any OS.
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const num = (raw) => Number(String(raw).replace(/_/g, ""));

const plinkoPage = read("src/app/casino/plinko/[matchId]/PageClient.tsx");
const plinkoStore = read("src/lib/plinko-pvp/serverStore.js");
const plinkoRoute = read("src/app/api/plinko-pvp/match/[matchId]/route.js");

const blackjackPage = read("src/app/casino/blackjack/[matchId]/PageClient.tsx");
const blackjackStore = read("src/lib/blackjack-pvp/serverStore.js");
const blackjackRead = read("src/app/api/blackjack-pvp/match/[matchId]/route.js");
const blackjackContinue = read(
  "src/app/api/blackjack-pvp/match/[matchId]/continue/route.js",
);

const towerPage = read("src/app/casino/tower-arena/game/[matchId]/PageClient.tsx");
const towerStore = read("src/lib/tower-arena/serverStore.ts");
const towerResolver = read("src/lib/tower-arena/turnResolver.ts");
const towerRoute = read("src/app/api/tower-arena/ai-turn/route.ts");
const towerGetMatch = read("src/app/api/tower-arena/get-match/route.ts");

// ── Plinko ────────────────────────────────────────────────────────────

test("plinko: the page itself wakes the bot for every ball of a free AI match", () => {
  const start = plinkoPage.indexOf("AI launch recovery");
  assert.ok(start > 0, "the page must carry a bot-launch effect");
  const body = plinkoPage.slice(start, plinkoPage.indexOf("Socket subscription"));

  // Scoped to a free AI match with a launchable ball and an uncommitted bot —
  // so a human duel keeps its plain poll and never posts /ai-turn.
  assert.ok(body.includes("!match?.isAi"), "only free AI matches wake the bot");
  assert.ok(body.includes("MATCH_STATUS.BALL_1"), "the ask is gated on a live ball");
  assert.ok(
    body.includes("match.p2CurrentInputs"),
    "the page stops asking once the bot has committed",
  );
  assert.ok(
    body.includes("`/api/plinko-pvp/match/${matchId}/ai-turn`"),
    "the page drives the bot through the dedicated ai-turn route",
  );
  // One ask per ball: keying on (matchId, currentBall) is what stops the effect
  // from re-posting on every render while the ball is open.
  assert.ok(
    body.includes("`${matchId}:${match.currentBall}`"),
    "the ask must be keyed per ball, not per render",
  );
  assert.ok(
    body.includes("setAiRetry((value) => value + 1)"),
    "a failed ask must be retried, not swallowed",
  );
  assert.ok(
    body.includes("await fetchStatus()"),
    "a successful ask repaints the board instead of waiting for the poll",
  );
});

test("plinko: the page is the only trigger, so the bot turn has no server gate to miss", () => {
  const start = plinkoStore.indexOf("export async function playAiTurn({ userId, matchId })");
  assert.ok(start > 0, "the store must expose playAiTurn");
  const body = plinkoStore.slice(start, plinkoStore.indexOf("export async function createOrJoin"));

  // If the store ever grows a "the caller asked too early/late" gate, the
  // page's fixed 900ms delay has to be re-derived against it.
  assert.ok(
    !/Date\.now\(\)/.test(body),
    "playAiTurn must not gate itself on a clock the page cannot see",
  );
  assert.ok(body.includes("LAUNCHABLE_STATES.has(match.status)"));
  assert.ok(body.includes("isFreeAiMatch(match)") && body.includes("match.player1Id !== userId"));
  assert.ok(body.includes("asAi: true"), "the bot must ride the same launch path as a human");

  // Free AI matches are untimed, which also opts them out of the AFK
  // auto-launch backstop. Nothing else launches the bot's ball — so the page's
  // per-ball POST above is load-bearing for the match to resolve at all.
  assert.ok(
    plinkoStore.includes("!isFreeAiMatch(match) &&"),
    "AI matches are exempt from the AFK auto-launch, so the page's ask is the only path",
  );
  assert.ok(
    !plinkoRoute.includes("playAiTurn({"),
    "the read route does not run the bot either — the page is the sole trigger",
  );
});

// ── Blackjack ─────────────────────────────────────────────────────────

test("blackjack: the bot is driven by the human's own reads, not a client endpoint", () => {
  assert.ok(
    !blackjackPage.includes("ai-turn"),
    "the page never posts /ai-turn — the server runs the bot on read",
  );

  const readBody = blackjackRead.slice(blackjackRead.indexOf("export async function GET"));
  assert.ok(
    readBody.includes("if (match.isAi && match.player1Id === userId)"),
    "the read route runs the bot only for the human seat of a free AI match",
  );
  assert.ok(
    readBody.includes("await playAiTurn({ userId, matchId })"),
    "the read route is what actually advances the bot",
  );
  assert.ok(
    blackjackContinue.includes("if (match.isAi && match.player1Id === userId)") &&
      blackjackContinue.includes("playAiTurn"),
    "the between-rounds continue must also run the bot, or round 2 never opens",
  );

  // A poll is therefore sufficient. Without one, a human who sits still would
  // leave the bot mid-hand.
  assert.ok(
    blackjackPage.includes("setInterval(() => fetchStatus({ silent: true }), 5000)"),
    "the match page must poll so the bot's hand advances while the human sits still",
  );
  assert.ok(
    /await fetchStatus\(\{ silent: true \}\);/.test(blackjackPage),
    "the page refetches after its own action, which is when the bot must respond",
  );
});

test("blackjack: playAiTurn has no clock gate and always reaches a terminal state", () => {
  const start = blackjackStore.indexOf("export async function playAiTurn({ userId, matchId })");
  assert.ok(start > 0);
  const body = blackjackStore.slice(start, blackjackStore.indexOf("// ── Action validators"));

  assert.ok(!/Date\.now\(\)/.test(body), "the bot must not wait on a server-side clock");
  assert.ok(body.includes("while (actions < 16)"), "the bot plays until it is done");
  assert.ok(body.includes("chooseAiAction(latest)"));

  // The policy has to terminate, or the round can only resolve via the AFK
  // sweep — the human would watch the bot hold a hand forever.
  const hand = (values) => values.map((value) => ({ suit: "♠", value }));
  const match = (values, state = PLAYER_STATE.PLAYING, extras = {}) => ({
    player2Hand: hand(values),
    player2State: state,
    player2UsedSwap: 0,
    player2FrozenCard: null,
    player2HeldResolved: null,
    ...extras,
  });

  assert.equal(chooseAiAction(match(["2", "3"])).action, ACTION_TYPE.HIT, "hits below 17");
  assert.equal(chooseAiAction(match(["10", "7"])).action, ACTION_TYPE.STAND, "stands on 17");
  assert.equal(chooseAiAction(match(["10", "K"])).action, ACTION_TYPE.STAND, "stands on 20");
  assert.equal(
    chooseAiAction(match(["10", "K"], PLAYER_STATE.BUSTED, { player2UsedSwap: 1 })).action,
    ACTION_TYPE.STAND,
    "a busted bot that has spent its swap finalises the hand so the round can resolve",
  );
  assert.equal(
    chooseAiAction(match(["10", "K"], PLAYER_STATE.STOOD)),
    null,
    "a settled bot is done — no action, no loop",
  );
});

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

  // Mines PvP — the server paces the bot (idempotent: a refused ask is safe to
  // repeat). Client and server must share the one exported constant, otherwise
  // the page retriggers before the gate opens and the bot's second tile stalls.
  const minesConstants = read("src/lib/mines-pvp/constants.js");
  const minesStore = read("src/lib/mines-pvp/serverStore.js");
  const minesPage = read("src/app/casino/mines-pvp/[matchId]/PageClient.tsx");
  assert.ok(minesConstants.includes("export const AI_PICK_DELAY_MS ="));
  assert.ok(
    minesPage.includes("AI_PICK_DELAY_MS,") &&
      /setTimeout\(resolve, AI_PICK_DELAY_MS\)/.test(minesPage),
    "the page must pace its retrigger with the shared constant",
  );
  assert.ok(
    minesStore.includes("if (!aiPickDelayElapsed(match))"),
    "the server holds a paced ask off rather than failing it",
  );
  assert.ok(
    minesStore.includes("alreadyPlayed: true"),
    "a paced-hold answer stays success-shaped so the client can just re-ask",
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
