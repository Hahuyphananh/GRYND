// qa/hillstrike-practice-check.mjs
//
// Plays the REAL Hillstrike practice page in a real browser, end to end.
//
// The unit suites cover the engine, the physics and the bot; this one covers the
// thing a human actually touches — a canvas battlefield you aim by dragging,
// at desktop and phone widths. It checks, in order:
//
//   1. the board mounts with BOTH gunners (three lives each), their towers and
//      their hills DRAWN (the canvas has real colour, not a blank rectangle);
//   2. a drag shows a trajectory preview BEFORE the shot is fired, and the Fire
//      button only unlocks once the aim is a real one;
//   3. the opening volley is one shot; every later volley is two — and the turn
//      really does alternate (player1 → player2 → player1 …);
//   4. input is DEAD while a projectile resolves and while the bot owns the
//      turn: a drag there changes nothing;
//   5. hitting a tower damages or fells blocks and never costs a life, while a
//      direct hit costs exactly one;
//   6. the match ends the instant a gunner runs out of lives, the shared result
//      screen reports it, and the loser has zero lives;
//   7. Restart (both the in-match button and the result screen's "New layout")
//      deals a brand-new generated battlefield with full lives and a fresh turn;
//   8. the layout fits 1280×800 and phones (390×844, 320×568) with no sideways
//      overflow, and the whole loop (drag → preview → fire → resolve) works by
//      pointer at 320px;
//   9. no JS errors anywhere.
//
// It never simulates the game itself: every shot is a REAL drag and a REAL
// press of Fire, and every verdict is read back out of the board, which renders
// the rules engine's own state.
//
// ── HOW THE HARNESS AIMS ──────────────────────────────────────────────────
// Like a player: it reads the dotted preview. Every drag writes the engine's
// resolved impact into `data-preview-*`, so the harness drags, reads where that
// shot would land, and refines toward the target — a coarse scan, then a local
// search that halves its steps. The seed is pinned (`?seed=`) so the FIRST
// layout (and the enemy's position, which never moves) is known before the page
// loads; after that the search is closed-loop on what the board reports, so a
// crater or a fallen tower is handled exactly as a human would handle it.
//
// Screenshots and a JSON report land in qa/reports/hillstrike-practice/.
//
// The server must already be running (same convention as the other qa scripts):
//   CLERK_SECRET_KEY="" npx next dev -p 3210
//   node --import tsx qa/hillstrike-practice-check.mjs
//
// `--quick` skips the phone passes.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createInitialState } from "../src/lib/hillstrike/rules.ts";
import {
  DEFAULT_MAX_PULL,
  IMPACT_KINDS,
  POWER_MAX,
} from "../src/lib/hillstrike/constants.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports", "hillstrike-practice");
mkdirSync(REPORTS, { recursive: true });

const BASE = process.env.BASE || "http://localhost:3210";
const ROUTE = "/casino/hillstrike/play-ai";
const QUICK = process.argv.includes("--quick");
/** A pinned layout: the first battlefield (and the enemy's fixed position) is known. */
const SEED = 424242;
const MAX_SHOTS = 24;

const FIELD_SELECTOR = '[data-testid="hillstrike-battlefield"]';
const FIRE_SELECTOR = '[data-testid="hillstrike-fire"]';
const RESTART_SELECTOR = '[data-testid="hillstrike-restart"]';

const results = [];
const problems = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Make the browser look like a returning visitor: the first-load brand splash is
 * skipped and the cookie banner is already answered, so neither overlay can
 * swallow the drags this harness means to make.
 */
async function prepareVisitor(context) {
  await context.addInitScript(() => {
    try {
      window.sessionStorage.setItem("grynd:splash:seen:v1", "1");
      window.localStorage.setItem("grynd_cookie_consent", "declined");
      // A remembered tier would leak between passes; every pass starts neutral.
      window.localStorage.removeItem("grynd_ai_difficulty:hillstrike");
    } catch {
      /* storage unavailable — the harness still waits the splash out */
    }
  });
}

function attachErrorWatch(page, label) {
  const errors = [];
  const httpNoise = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/^Failed to load resource/.test(message.text())) httpNoise.push(message.text());
    else errors.push(`console: ${message.text()}`);
  });
  return {
    flush() {
      record(
        `${label}: no JS errors`,
        errors.length === 0,
        errors.slice(0, 4).join(" | ") || `${httpNoise.length} expected HTTP failure(s)`,
      );
    },
  };
}

async function waitForBoard(page, label) {
  await page.waitForSelector(FIELD_SELECTOR, { timeout: 45000 });
  try {
    await page.waitForFunction(() => !document.querySelector('[aria-label="Loading GRYND"]'), null, {
      timeout: 20000,
    });
  } catch {
    record(`${label}: the loading splash clears`, false, 'the "Loading GRYND" overlay stayed up');
  }
  // The board generates its layout on the client; wait for the first one.
  await page.waitForFunction(
    ([selector]) => {
      const node = document.querySelector(selector);
      return Boolean(node && node.dataset.turn && node.dataset.seed);
    },
    [FIELD_SELECTOR],
    { timeout: 20000 },
  );
}

/** The whole board as the page renders it. */
async function facts(page) {
  return page.evaluate((selector) => {
    const node = document.querySelector(selector);
    const data = node?.dataset ?? {};
    const number = (value) => (value === "" || value === undefined ? null : Number(value));
    const text = (testId) =>
      document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? "";
    const dialog = document.querySelector('[role="dialog"]');
    const fire = document.querySelector('[data-testid="hillstrike-fire"]');
    return {
      turn: data.turn ?? "",
      turnIndex: number(data.turnIndex),
      status: data.status ?? "",
      seed: number(data.seed),
      openingSeat: data.openingSeat ?? "",
      blocks: number(data.blocks),
      cracked: number(data.cracked),
      terrain: number(data.terrainSignature),
      lives: {
        player1: number(data.livesPlayer1),
        player2: number(data.livesPlayer2),
      },
      shotsRemaining: number(data.shotsRemaining),
      winner: data.winner ?? "",
      aimAngle: number(data.aimAngle),
      aimPower: number(data.aimPower),
      previewKind: data.previewImpact ?? "",
      previewX: number(data.previewX),
      previewY: number(data.previewY),
      previewSteps: number(data.previewSteps),
      lastSeat: data.lastSeat ?? "",
      lastImpact: data.lastImpact ?? "",
      lastTarget: data.lastTarget ?? "",
      lastLivesLost: number(data.lastLivesLost),
      interactive: data.interactive === "1",
      resolving: data.resolving === "1",
      dragging: data.dragging === "1",
      fireDisabled: fire ? fire.disabled : null,
      statusText: text("hillstrike-status"),
      aimReadout: text("hillstrike-aim-readout"),
      notice: text("hillstrike-notice"),
      youPips: document.querySelectorAll('[data-testid="hillstrike-seat-you-lives"] span').length,
      aiPips: document.querySelectorAll('[data-testid="hillstrike-seat-ai-lives"] span').length,
      dialog: dialog ? dialog.getAttribute("aria-label") ?? "" : "",
      canvas: Boolean(node && node.querySelector("canvas")),
    };
  }, FIELD_SELECTOR);
}

/** A coarse fingerprint of what is actually painted on the canvas. */
async function canvasPaint(page) {
  return page.evaluate((selector) => {
    const canvas = document.querySelector(`${selector} canvas`);
    if (!canvas) return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    for (let index = 0; index < data.length; index += 4 * 97) {
      sum += data[index] + data[index + 1] + data[index + 2];
    }
    const colors = new Set();
    for (let index = 0; index < data.length; index += 4 * 397) {
      colors.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
    }
    return { sum, colors: colors.size, width: canvas.width, height: canvas.height };
  }, FIELD_SELECTOR);
}

/** Wait two frames, so a React state update from a pointer move has landed. */
function nextPaint(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      }),
  );
}

/**
 * One slingshot gesture for `angleDeg`/`power`.
 *
 * The engine's own conversion (`aimFromDrag`) says angle = atan2(-pullY, pullX)
 * and power = |pull| / maxPull · POWER_MAX, so pressing at `start` and dragging
 * to `start - pull` is exactly that aim. The board reports the aim it actually
 * ended up with, which is what the search uses — a clamp at a small viewport
 * simply means a slightly different candidate, never a wrong one.
 */
async function dragAim(page, angleDeg, power) {
  const box = await page.locator(FIELD_SELECTOR).boundingBox();
  if (!box) throw new Error("hillstrike: the battlefield has no layout box");
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const radians = (angleDeg * Math.PI) / 180;
  const pull = clamp(power, 0, POWER_MAX) / POWER_MAX * DEFAULT_MAX_PULL;
  const startX = box.x + box.width * 0.5;
  const startY = box.y + box.height * 0.3;
  const endX = clamp(startX - Math.cos(radians) * pull, 3, viewport.width - 3);
  const endY = clamp(startY + Math.sin(radians) * pull, 3, viewport.height - 3);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 4 });
  await nextPaint(page);
  const preview = await page.evaluate((selector) => {
    const data = document.querySelector(selector)?.dataset ?? {};
    const number = (value) => (value === "" || value === undefined ? null : Number(value));
    return {
      angle: number(data.aimAngle),
      power: number(data.aimPower),
      kind: data.previewImpact ?? "",
      x: number(data.previewX),
      y: number(data.previewY),
      steps: number(data.previewSteps),
    };
  }, FIELD_SELECTOR);
  await page.mouse.up();
  return preview;
}

/**
 * Find a drag that lands where we want, reading the engine's preview.
 *
 * `target` is either a world point (aim at it) or `"block"` (any line that lands
 * on a tower). The scan is coarse, then the best candidate is refined with
 * halving steps — the same way a player nudges an arc.
 */
async function findShot(page, { point = null, kind = null, angles = null } = {}) {
  const samples = [];
  const evaluate = async (angle, power) => {
    const preview = await dragAim(page, angle, power);
    const sample = { angle, power, preview };
    if (point && preview.x !== null && preview.y !== null) {
      sample.distance = Math.hypot(preview.x - point.x, preview.y - point.y);
    }
    samples.push(sample);
    return sample;
  };
  const accepted = (sample) => {
    if (kind && sample.preview.kind === kind) return true;
    if (!kind && !point) return true;
    return false;
  };

  // 1. A coarse scan over the whole forward arc.
  const sweepAngles = angles ?? [8, 18, 28, 38, 48, 58, 68, 80];
  for (const angle of sweepAngles) {
    for (const power of [45, 65, 85, 100]) {
      const sample = await evaluate(angle, power);
      if (accepted(sample)) return { best: sample, samples, exact: true };
    }
  }

  if (kind) {
    // Nothing landed on a tower at those four powers: try the gaps.
    for (const angle of sweepAngles) {
      for (const power of [35, 55, 75, 95]) {
        const sample = await evaluate(angle, power);
        if (accepted(sample)) return { best: sample, samples, exact: true };
      }
    }
    const best = samples.reduce((a, b) => (b.preview.kind === "block" ? b : a), samples[0]);
    return { best, samples, exact: best.preview.kind === "block" };
  }

  // 2. Local refinement toward the point, with halving steps.
  let best = samples
    .filter((sample) => sample.distance !== undefined)
    .sort((a, b) => a.distance - b.distance)[0];
  let angleStep = 6;
  let powerStep = 10;
  for (let round = 0; round < 10 && angleStep >= 0.5; round++) {
    const neighbours = [
      { angle: best.angle + angleStep, power: best.power },
      { angle: best.angle - angleStep, power: best.power },
      { angle: best.angle, power: best.power + powerStep },
      { angle: best.angle, power: best.power - powerStep },
      { angle: best.angle + angleStep / 2, power: best.power + powerStep / 2 },
      { angle: best.angle - angleStep / 2, power: best.power - powerStep / 2 },
    ];
    let improved = false;
    for (const candidate of neighbours) {
      const angle = clamp(candidate.angle, 2, 88);
      const power = clamp(candidate.power, 5, POWER_MAX);
      const sample = await evaluate(angle, power);
      if (accepted(sample)) return { best: sample, samples, exact: true };
      if (sample.distance !== undefined && sample.distance < best.distance) {
        best = sample;
        improved = true;
      }
    }
    if (!improved) {
      angleStep /= 2;
      powerStep /= 2;
    }
  }
  return { best, samples, exact: false };
}

async function fire(page) {
  await page.locator(FIRE_SELECTOR).click();
}

/** True once the board reports a projectile in flight. */
async function waitForResolving(page, { timeout = 5000 } = {}) {
  try {
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.dataset.resolving === "1",
      FIELD_SELECTOR,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until THIS shot has finished resolving.
 *
 * The authoritative state is installed when the projectile lands, so the snapshot
 * taken here is the state right after the impact — before the bot takes its turn.
 * That is what makes the per-shot invariants readable: `lastShot` is still ours.
 */
async function settle(page, { timeout = 25000 } = {}) {
  const deadline = Date.now() + timeout;
  const startedResolving = await waitForResolving(page);
  while (Date.now() < deadline) {
    const snapshot = await facts(page);
    if (!snapshot.resolving) {
      return { facts: snapshot, sawResolving: startedResolving };
    }
    await page.waitForTimeout(60);
  }
  return { facts: await facts(page), sawResolving: startedResolving, timedOut: true };
}

/**
 * Try to play while the board is locked (a projectile in flight, or the bot's
 * turn). A locked board must not even accept an aim.
 */
async function probeLockedInput(page) {
  const before = await facts(page);
  await dragAim(page, 42, 80);
  const after = await facts(page);
  return {
    locked: !after.interactive && after.aimAngle === null && after.previewKind === "",
    detail: `interactive=${before.interactive} aim=${after.aimReadout || "none"}`,
  };
}

/** Wait for the human's turn, watching that the bot's turn never accepts input. */
async function waitForHumanTurn(page, { timeout = 25000 } = {}) {
  const deadline = Date.now() + timeout;
  let opponentTurns = 0;
  while (Date.now() < deadline) {
    const snapshot = await facts(page);
    if (snapshot.status === "finished") return { facts: snapshot, opponentTurns };
    if (snapshot.turn === "player1" && snapshot.interactive) return { facts: snapshot, opponentTurns };
    if (snapshot.turn === "player2") opponentTurns += 1;
    await page.waitForTimeout(80);
  }
  return { facts: await facts(page), opponentTurns, timedOut: true };
}

const expectedBlocks = createInitialState({ seed: SEED }).battlefield.blocks.length;
const enemy = createInitialState({ seed: SEED }).battlefield.players.player2;

/**
 * Play one shot: aim, verify the preview, fire, watch the flight, and check the
 * invariants of the resolved state. Returns the facts after the shot.
 */
async function playShot(page, { target, label }) {
  const before = await waitForHumanTurn(page);
  if (before.timedOut || before.facts.status === "finished") {
    return { before: before.facts, after: before.facts, ended: true };
  }

  const start = before.facts;
  // Volley rule: the opening shot is alone, then every volley is two shots.
  const windowStart = start.lastSeat !== "player1";
  const expectedShots = start.turnIndex === 0 ? 1 : windowStart ? 2 : 1;
  record(
    `${label}: the volley counter is the engine's (${expectedShots} shot(s) left)`,
    start.shotsRemaining === expectedShots,
    `turnIndex=${start.turnIndex} lastSeat=${start.lastSeat || "none"} shots=${start.shotsRemaining}`,
  );

  const found = await findShot(
    page,
    target === "block" ? { kind: IMPACT_KINDS.BLOCK } : { point: enemy },
  );
  const aimed = await facts(page);

  const previewOk =
    aimed.previewKind !== "" &&
    aimed.previewSteps !== null &&
    aimed.previewSteps > 1 &&
    aimed.fireDisabled === false;
  record(
    `${label}: a trajectory preview is shown before firing`,
    previewOk,
    `impact=${aimed.previewKind || "none"} steps=${aimed.previewSteps} fire-disabled=${aimed.fireDisabled}`,
  );
  record(
    `${label}: the aim comes from the drag (angle/power read back)`,
    aimed.aimAngle !== null && aimed.aimPower !== null,
    `${aimed.aimReadout}`,
  );

  const paintBefore = await canvasPaint(page);
  await fire(page);

  // The board must animate, not teleport: two frames mid-flight differ.
  const resolving = await waitForResolving(page);
  const midFlight = await facts(page);
  const paintMid = await canvasPaint(page);
  await page.waitForTimeout(180);
  const paintLater = await canvasPaint(page);

  const after = await settle(page);
  const landed = after.facts;

  record(
    `${label}: the shot resolves completely before the next one is accepted`,
    resolving && after.sawResolving && !landed.resolving,
    `resolving seen=${resolving && after.sawResolving} still=${landed.resolving}`,
  );
  record(
    `${label}: the projectile is drawn in flight (two frames differ)`,
    Boolean(paintMid && paintLater) && paintMid.sum !== paintLater.sum,
    paintMid && paintLater ? `sum ${paintMid.sum} → ${paintLater.sum}` : "no canvas",
  );
  record(
    `${label}: the board changes after the impact`,
    Boolean(paintBefore && paintLater) && paintBefore.sum !== paintLater.sum,
    paintBefore && paintLater ? `sum ${paintBefore.sum} → ${paintLater.sum}` : "no canvas",
  );
  record(
    `${label}: input is disabled while the shot resolves (mid-flight probe)`,
    midFlight.interactive === false || midFlight.resolving === true,
    `resolving=${midFlight.resolving} interactive=${midFlight.interactive}`,
  );

  const aiLivesBefore = start.lives.player2;
  const yourLivesBefore = start.lives.player1;
  const impact = landed.lastImpact;
  const livesLost = landed.lastLivesLost;

  record(
    `${label}: the accepted shot is the human's and the engine recorded it`,
    landed.lastSeat === "player1" && Object.values(IMPACT_KINDS).includes(impact),
    `seat=${landed.lastSeat} impact=${impact} target=${landed.lastTarget || "none"}`,
  );

  if (impact === IMPACT_KINDS.PLAYER) {
    record(
      `${label}: a direct hit costs exactly one life`,
      livesLost === 1 && landed.lives.player2 === aiLivesBefore - 1,
      `livesLost=${livesLost} bot ${aiLivesBefore}→${landed.lives.player2}`,
    );
  } else {
    record(
      `${label}: structural/ground damage costs no life`,
      livesLost === 0 &&
        landed.lives.player2 === aiLivesBefore &&
        landed.lives.player1 === yourLivesBefore,
      `livesLost=${livesLost} lives ${JSON.stringify(landed.lives)}`,
    );
  }

  const structureMoved =
    landed.blocks < start.blocks ||
    landed.cracked > start.cracked ||
    landed.terrain !== start.terrain;
  record(
    `${label}: the impact changed the battlefield (blocks, cracks or ground)`,
    structureMoved || impact === IMPACT_KINDS.PLAYER,
    `blocks ${start.blocks}→${landed.blocks} cracked ${start.cracked}→${landed.cracked} ` +
      `terrain ${start.terrain}→${landed.terrain}`,
  );

  if (landed.status === "playing") {
    const expectedTurn = landed.shotsRemaining === 1 ? "player1" : "player2";
    record(
      `${label}: the turn passes by the engine's volley rule`,
      landed.turn === expectedTurn,
      `turn=${landed.turn} shotsRemaining=${landed.shotsRemaining}`,
    );
  }

  return {
    before: start,
    after: landed,
    aim: aimed,
    found,
    ended: landed.status === "finished",
    paintBefore,
  };
}

async function run() {
  const browser = await chromium.launch();

  // ── desktop ────────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await prepareVisitor(desktop);
  const page = await desktop.newPage();
  page.setDefaultTimeout(30000);
  const watch = attachErrorWatch(page, "desktop");

  const response = await page.goto(`${BASE}${ROUTE}/?seed=${SEED}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  record(
    "desktop: the practice route responds",
    Boolean(response) && response.status() < 400,
    `status=${response?.status()}`,
  );
  await waitForBoard(page, "desktop");

  // Pick a tier explicitly. Easy is deliberate: this harness plays EVERY branch of
  // the loop (structural shots, then direct hits, then a full match to zero
  // lives), and a near-perfect bot ends the match before the player gets those
  // shots. The bot's strength is measured in the fairness sweep, not here.
  await page.locator('[data-testid="ai-difficulty-hillstrike-easy"]').click();

  const opened = await facts(page);
  record(
    "desktop: both gunners start on three lives",
    opened.lives.player1 === 3 &&
      opened.lives.player2 === 3 &&
      opened.youPips === 3 &&
      opened.aiPips === 3,
    `lives=${JSON.stringify(opened.lives)} pips=${opened.youPips}/${opened.aiPips}`,
  );
  record(
    "desktop: the pinned layout is the engine's own battlefield",
    opened.seed === SEED && opened.blocks === expectedBlocks,
    `seed=${opened.seed} blocks=${opened.blocks}/${expectedBlocks}`,
  );
  record(
    "desktop: the canvas is painted (terrain, towers and both gunners)",
    Boolean(opened.canvas) && (await canvasPaint(page)).colors > 12,
    `colours=${(await canvasPaint(page)).colors}`,
  );
  record(
    "desktop: the opening shot belongs to the opening seat alone",
    opened.turnIndex === 0 &&
      opened.turn === opened.openingSeat &&
      opened.shotsRemaining === 1 &&
      opened.interactive,
    `turn=${opened.turn} opening=${opened.openingSeat} shots=${opened.shotsRemaining}`,
  );
  await page.screenshot({ path: join(REPORTS, "desktop-start.png"), fullPage: true });

  // A drag that is not fired must be reversible: Clear drops the aim and Fire
  // goes back to disabled.
  await dragAim(page, 40, 70);
  const aimedOnly = await facts(page);
  await page.locator('[data-testid="hillstrike-clear"]').click();
  const cleared = await facts(page);
  record(
    "desktop: Clear releases the aim and re-disables Fire",
    aimedOnly.previewKind !== "" &&
      cleared.aimAngle === null &&
      cleared.previewKind === "" &&
      cleared.fireDisabled === true,
    `aim=${aimedOnly.aimReadout} cleared=${cleared.aimReadout || "none"}`,
  );

  // ── the match loop ────────────────────────────────────────────────────
  let shots = 0;
  let sawPlayerHit = false;
  let sawStructureDamage = false;
  let sawTerrainChange = false;
  let sawBotTurnLocked = false;
  let finalFacts = opened;

  while (shots < MAX_SHOTS) {
    const target = shots < 2 ? "block" : "player";
    const label = `shot ${shots + 1}`;
    const played = await playShot(page, { target, label });
    if (played.ended) {
      finalFacts = played.after;
      break;
    }
    const start = played.before;
    const after = played.after;
    if (after.lastImpact === IMPACT_KINDS.PLAYER) sawPlayerHit = true;
    if (after.blocks < start.blocks || after.cracked > start.cracked) sawStructureDamage = true;
    if (after.terrain !== start.terrain) sawTerrainChange = true;
    shots += 1;
    finalFacts = after;

    // While the bot owns the turn, the board must refuse the human's input.
    if (after.status === "playing" && after.turn === "player2") {
      const probe = await probeLockedInput(page);
      if (probe.locked) sawBotTurnLocked = true;
      else console.log(`   ${label}: lock probe — ${probe.detail}`);
    }
    const probe = await waitForHumanTurn(page, { timeout: 25000 });
    if (probe.facts.status === "finished") {
      finalFacts = probe.facts;
      break;
    }
    console.log(
      `   ${label} done: impact=${after.lastImpact} lives=${after.lives.player1}/${after.lives.player2} ` +
        `blocks=${after.blocks}`,
    );
  }

  record(
    "match: at least one direct hit landed (a life was really taken)",
    sawPlayerHit,
    `shots=${shots}`,
  );
  record(
    "match: a tower was damaged or felled without costing a life",
    sawStructureDamage,
    "",
  );
  record("match: the ground was deformed by an impact", sawTerrainChange, "");
  record("match: the bot's turn refuses the human's input", sawBotTurnLocked, "");
  record(
    "match: the match finished inside the action budget",
    finalFacts.status === "finished",
    `status=${finalFacts.status} after ${shots} shots`,
  );

  if (finalFacts.status === "finished") {
    const loserLives = finalFacts.lives.player1 === 0 ? finalFacts.lives.player1 : finalFacts.lives.player2;
    record(
      "match: the loser has zero lives and the engine names a winner",
      loserLives === 0 && finalFacts.winner !== "",
      `lives=${JSON.stringify(finalFacts.lives)} winner=${finalFacts.winner}`,
    );
    record(
      "match: the result screen reports a win or a defeat",
      /WIN|LOSS|DRAW/i.test(finalFacts.dialog),
      `dialog="${finalFacts.dialog}"`,
    );
    await page.screenshot({ path: join(REPORTS, "desktop-result.png"), fullPage: true });

    // The result screen's "New layout" is the same fresh-layout path.
    await page.locator('[role="dialog"]').getByRole("button", { name: /new layout/i }).click();
    await page.waitForTimeout(600);
    const fresh = await facts(page);
    record(
      "result: New layout deals a brand-new battlefield",
      fresh.status === "playing" &&
        fresh.turnIndex === 0 &&
        fresh.lives.player1 === 3 &&
        fresh.lives.player2 === 3 &&
        fresh.blocks > 0 &&
        fresh.seed !== finalFacts.seed,
      `status=${fresh.status} seed ${finalFacts.seed}→${fresh.seed} blocks=${fresh.blocks}`,
    );
    await page.screenshot({ path: join(REPORTS, "desktop-fresh.png"), fullPage: true });
  }

  // The in-match Restart must do the same from a live board.
  const beforeRestart = await facts(page);
  await page.locator(RESTART_SELECTOR).click();
  await page.waitForTimeout(500);
  const restarted = await facts(page);
  record(
    "restart: the in-match button resets a live match",
    restarted.status === "playing" &&
      restarted.turnIndex === 0 &&
      restarted.shotsRemaining === 1 &&
      restarted.lives.player1 === 3 &&
      restarted.lives.player2 === 3 &&
      restarted.seed !== beforeRestart.seed,
    `status=${restarted.status} seed ${beforeRestart.seed}→${restarted.seed}`,
  );

  watch.flush("desktop");
  await desktop.close();

  // ── phones ─────────────────────────────────────────────────────────────
  if (!QUICK) {
    for (const size of [
      { name: "phone-390", width: 390, height: 844 },
      { name: "phone-320", width: 320, height: 568 },
    ]) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: true,
        hasTouch: true,
      });
      await prepareVisitor(context);
      const phone = await context.newPage();
      phone.setDefaultTimeout(30000);
      const phoneWatch = attachErrorWatch(phone, size.name);
      await phone.goto(`${BASE}${ROUTE}/?seed=${SEED}`, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await waitForBoard(phone, size.name);
      await phone.waitForTimeout(400);

      const layout = await phone.evaluate((selector) => {
        const field = document.querySelector(selector);
        const rect = field.getBoundingClientRect();
        const hud = document.querySelector('[data-testid="hillstrike-seat-you"]');
        const fire = document.querySelector('[data-testid="hillstrike-fire"]');
        return {
          viewport: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          height: Math.round(rect.height),
          hudVisible: Boolean(hud && hud.getBoundingClientRect().height > 0),
          fireVisible: Boolean(fire && fire.getBoundingClientRect().height > 0),
        };
      }, FIELD_SELECTOR);

      record(
        `${size.name}: nothing overflows sideways`,
        layout.documentWidth <= layout.viewport + 1 &&
          layout.left >= -1 &&
          layout.right <= layout.viewport + 1,
        `doc=${layout.documentWidth} viewport=${layout.viewport} board=${layout.left}…${layout.right}`,
      );
      record(
        `${size.name}: the board and its controls are usable`,
        layout.height >= 120 && layout.hudVisible && layout.fireVisible,
        `board=${layout.height}px hud=${layout.hudVisible} fire=${layout.fireVisible}`,
      );

      // The whole loop is reachable by pointer at this width: drag, preview, fire.
      const found = await findShot(phone, { kind: IMPACT_KINDS.BLOCK });
      const aimed = await facts(phone);
      record(
        `${size.name}: a drag aims and previews on a phone`,
        aimed.previewKind !== "" && aimed.aimPower !== null && aimed.fireDisabled === false,
        `impact=${aimed.previewKind || "none"} aim=${aimed.aimReadout}`,
      );
      const shotCount = found.samples.length;
      await fire(phone);
      const settled = await settle(phone, { timeout: 30000 });
      record(
        `${size.name}: the shot resolves on a phone`,
        settled.sawResolving &&
          !settled.facts.resolving &&
          settled.facts.turnIndex !== null &&
          settled.facts.seed === SEED,
        `shots searched=${shotCount} turnIndex=${settled.facts.turnIndex} status=${settled.facts.status}`,
      );

      await phone.screenshot({ path: join(REPORTS, `${size.name}.png`), fullPage: true });
      phoneWatch.flush(size.name);
      await context.close();
    }
  }

  await browser.close();

  const report = {
    base: BASE,
    route: ROUTE,
    seed: SEED,
    ranAt: new Date().toISOString(),
    passed: results.filter((entry) => entry.passed).length,
    failed: problems.length,
    problems,
    results,
  };
  writeFileSync(join(REPORTS, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${report.passed}/${results.length} checks passed`);
  if (problems.length > 0) {
    console.log(`\nFAILURES:\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  }
}

await run();
