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

  // Mines PvP — simultaneous, independent boards (no shared turn formula).
  // The bot plays its OWN board; the status poll advances it and the AI-turn
  // endpoint is an idempotent wake-up the page fires after each own action.
  const minesConstants = read("src/lib/mines-pvp/constants.js");
  const minesStore = read("src/lib/mines-pvp/serverStore.js");
  const minesPage = read("src/app/casino/mines-pvp/[matchId]/PageClient.tsx");
  // The legacy pacing constant is still exported for older clients.
  assert.ok(minesConstants.includes("export const AI_PICK_DELAY_MS ="));
  // The reworked page wakes the bot through the endpoint (not a local timer).
  assert.ok(
    minesPage.includes("`/api/mines-pvp/match/${matchId}/ai-turn`"),
    "the page must ask the server to advance the bot after a human action",
  );
  assert.ok(
    minesStore.includes("playAiTurnInTransaction") &&
      minesStore.includes("isFreeAiMatch(match)"),
    "the read route advances the bot on its own board for a free AI match",
  );
  assert.ok(
    minesStore.includes("alreadyPlayed: true"),
    "a redundant ask stays success-shaped so the client can just re-ask",
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

// ── Read-driven bots: the page has to keep reading ────────────────────────

test("mines: the practice bot is kept moving while the player watches", () => {
  // The bot's whole board is played SERVER-side on READ
  // (`playAiTurnInTransaction`, run from this page's status fetch), and the
  // match page syncs event-driven on purpose. So a player who stopped acting
  // froze the bot mid-board — and, because the 180s clock and the "both boards
  // done" resolution are applied on a read too, could leave the match hanging.
  // The page therefore heartbeats the bot's own read while the bot still has a
  // board to play.
  const minesPage = read("src/app/casino/mines-pvp/[matchId]/PageClient.tsx");
  assert.ok(
    minesPage.includes('from "../../../../hooks/usePracticeBotHeartbeat"'),
    "the page must use the shared practice-bot heartbeat",
  );
  const start = minesPage.indexOf("Practice bot heartbeat");
  assert.ok(start > 0, "the page must carry a bot-heartbeat block");
  const body = minesPage.slice(start, start + 1600);
  assert.ok(body.includes("usePracticeBotHeartbeat(botStillPlaying, fetchStatus)"));
  assert.ok(
    body.includes("isAi && isActive && !match?.opponentLocked && !match?.opponentCompleted"),
    "it runs only while a practice bot still has a board to play",
  );
  // The read it beats with is the page's own authoritative snapshot, and that
  // read is what advances the bot server-side.
  const minesStore = read("src/lib/mines-pvp/serverStore.js");
  assert.ok(minesStore.includes("playAiTurnInTransaction"));
  const readStart = minesStore.indexOf("export async function fetchMatchWithAutoResolve");
  assert.ok(readStart > 0 && minesStore.slice(readStart, readStart + 1800).includes("playAiTurnInTransaction"));
});

test("speed typing: the practice bot is kept racing while the player reads", () => {
  // The bot's race is PROJECTED from the elapsed clock and written on READ
  // (`advanceAiRace`), and the match page syncs event-driven on purpose. A
  // player who paused to read the passage therefore froze the bot mid-race (and
  // could miss the both-finished resolve that the same read performs). The page
  // heartbeats the bot's own read while it is still racing.
  const page = read("src/app/casino/speed-typing/[matchId]/PageClient.tsx");
  assert.ok(
    page.includes('from "../../../../hooks/usePracticeBotHeartbeat"'),
    "the page must use the shared practice-bot heartbeat",
  );
  const start = page.indexOf("Practice bot heartbeat");
  assert.ok(start > 0, "the page must carry a bot-heartbeat block");
  const body = page.slice(start, start + 1400);
  assert.ok(body.includes("const botStillRacing ="), "the gate must be named");
  // It runs for a practice race that has started, is not settled, and whose bot
  // has not already finished.
  for (const clause of [
    "opponentIsAi &&",
    "!finished &&",
    "!resolved &&",
    "goAtMs != null &&",
    "now >= goAtMs &&",
    "race?.opponent?.finished !== true",
  ]) {
    assert.ok(body.includes(clause), `the gate must include \`${clause}\``);
  }
  assert.ok(body.includes("usePracticeBotHeartbeat(botStillRacing, () => load({ silent: true }))"));

  // The read it beats with is the page's own snapshot loader, and the store's
  // read path is what advances the bot.
  const store = read("src/lib/speed-typing/serverStore.ts");
  const fetchStart = store.indexOf("export async function fetchMatch(");
  assert.ok(
    fetchStart > 0 && store.slice(fetchStart, fetchStart + 2000).includes("advanceAiIfPractice"),
    "the read path must advance the bot",
  );
});

test("sudoku duel: the practice bot is kept playing while the player thinks", () => {
  // Same wiring as Speed Typing: the bot's board is advanced on READ
  // (`advanceAiMatch`, paced from the clock) and the page syncs event-driven.
  const page = read("src/app/casino/sudoku-duel/[matchId]/PageClient.tsx");
  assert.ok(
    page.includes('from "../../../../hooks/usePracticeBotHeartbeat"'),
    "the page must use the shared practice-bot heartbeat",
  );
  const start = page.indexOf("Practice bot heartbeat");
  assert.ok(start > 0, "the page must carry a bot-heartbeat block");
  const body = page.slice(start, start + 1200);
  assert.ok(body.includes("const botStillPlaying ="), "the gate must be named");
  assert.ok(
    body.includes("Boolean(match?.isAi) && phase === \"racing\" && !terminal && !match?.opponent?.completed"),
    "it runs only while a practice bot still has a board to play",
  );
  assert.ok(body.includes("usePracticeBotHeartbeat(botStillPlaying, load)"));

  const store = read("src/lib/sudoku-duel/serverStore.ts");
  const fetchStart = store.indexOf("export async function fetchMatch(");
  assert.ok(
    fetchStart > 0 && store.slice(fetchStart, fetchStart + 2200).includes("advanceAiIfPractice"),
    "the read path must advance the bot",
  );
});
