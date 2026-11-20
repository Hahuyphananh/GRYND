// qa/solitaire-live-modes-check.mjs
//
// PLAY THE REAL GAME. The component harness proves the animation layer; this
// drives the actual `/solitaire` and `/daily` routes against the dev server:
//
//   * start a Solo deal, draw from the stock, and make a legal card move by
//     clicking the board the way a player does;
//   * verify the draw/reveal animations run on the authoritative board;
//   * verify a placement creates the shared card cue (660/880 oscillators);
//   * verify the cue is silent when muted or when reduced motion is on;
//   * start the Daily challenge and draw from its real server deal.
//
// No game state is faked: moves are found from the rendered DOM and submitted
// through the board's own click model.
//
// Run (dev server on :3000): node qa/solitaire-live-modes-check.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = join(root, "qa", "reports");
mkdirSync(REPORTS, { recursive: true });
const BASE = process.env.SOLITAIRE_QA_BASE || "http://localhost:3000";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ channel: "chrome" });
}

// Count the tones the shared audio engine actually schedules, and remember
// their frequencies. playCardPlace is 660 Hz then 880 Hz; the UI click is 900.
const instrument = () => {
  window.__cardAudioFreqs = [];
  const proto = window.OscillatorNode?.prototype;
  if (!proto || proto.__gryndPatched) return;
  const start = proto.start;
  proto.start = function patchedStart(...args) {
    try {
      window.__cardAudioFreqs.push(Number(this.frequency.value));
    } catch {
      // A frequency that cannot be read is simply not evidence of a cue.
    }
    return start.apply(this, args);
  };
  proto.__gryndPatched = true;
};
const frequencies = (page) => page.evaluate(() => window.__cardAudioFreqs ?? []);
const playedPlacementCue = async (page) => {
  const freqs = await frequencies(page);
  return freqs.includes(660) && freqs.includes(880);
};

const watchErrors = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
};

const COLUMNS = async (page) =>
  page.evaluate(() => {
    const result = [];
    for (let column = 0; column < 7; column += 1) {
      const el = document.querySelector(`[data-testid="solitaire-column-${column}"]`);
      if (!el) continue;
      const cards = [...el.querySelectorAll('[data-testid^="solitaire-card-"]')].map((node) => {
        const card = node.dataset.card ? node.dataset.card.split("-") : null;
        return {
          index: Number(node.dataset.testid.split("-").pop()),
          faceUp: node.dataset.faceUp === "true",
          suit: card ? card[0] : null,
          rank: card ? Number(card[1]) : null,
        };
      });
      result.push({ column, cards });
    }
    return result;
  });

const isRed = (suit) => suit === "hearts" || suit === "diamonds";

/** A legal tableau-to-tableau run move, preferring one that flips a hidden card. */
function findTableauMove(columns) {
  const candidates = [];
  for (const source of columns) {
    const pile = source.cards;
    for (let index = pile.length - 1; index >= 0; index -= 1) {
      const head = pile[index];
      if (!head.faceUp) break;
      // The suffix from `index` must be a valid descending, alternating run.
      let valid = true;
      for (let k = index; k < pile.length - 1; k += 1) {
        const a = pile[k];
        const b = pile[k + 1];
        if (!a.faceUp || !b.faceUp || a.rank !== b.rank + 1 || isRed(a.suit) === isRed(b.suit)) {
          valid = false;
          break;
        }
      }
      if (!valid) break;
      for (const target of columns) {
        if (target.column === source.column) continue;
        const top = target.cards[target.cards.length - 1];
        let placement = null;
        if (!top) {
          if (head.rank === 13) placement = { kind: "empty" };
        } else if (
          top.faceUp &&
          top.rank === head.rank + 1 &&
          isRed(top.suit) !== isRed(head.suit)
        ) {
          placement = { kind: "card", index: target.cards.length - 1 };
        }
        if (!placement) continue;
        candidates.push({
          srcColumn: source.column,
          srcIndex: index,
          dstColumn: target.column,
          placement,
          reveals: index > 0 && pile[index - 1].faceUp === false,
          runLength: pile.length - index,
        });
      }
    }
  }
  candidates.sort(
    (a, b) => Number(b.reveals) - Number(a.reveals) || a.runLength - b.runLength,
  );
  return candidates[0] ?? null;
}

/** A waste-to-tableau or waste-to-foundation move, if one is visible. */
async function findWasteMove(page, columns) {
  const card = await page.evaluate(() => {
    const top = document.querySelector('[data-testid="solitaire-waste-top"]');
    if (!top?.dataset.card) return null;
    const [suit, rank] = top.dataset.card.split("-");
    return { suit, rank: Number(rank) };
  });
  if (!card) return null;
  for (const target of columns) {
    const top = target.cards[target.cards.length - 1];
    if (!top) {
      if (card.rank === 13) {
        return { kind: "waste-tableau", dstColumn: target.column, placement: { kind: "empty" } };
      }
    } else if (top.faceUp && top.rank === card.rank + 1 && isRed(top.suit) !== isRed(card.suit)) {
      return {
        kind: "waste-tableau",
        dstColumn: target.column,
        placement: { kind: "card", index: target.cards.length - 1 },
      };
    }
  }
  const suits = ["spades", "hearts", "diamonds", "clubs"];
  for (const suit of suits) {
    const foundation = await page.evaluate((s) => {
      const el = document.querySelector(`[data-testid="solitaire-foundation-${s}"]`);
      if (!el) return { exists: false };
      const card = el.querySelector("[data-card]");
      return {
        exists: true,
        rank: card?.dataset.card ? Number(card.dataset.card.split("-")[1]) : 0,
      };
    }, suit);
    if (!foundation.exists) continue;
    if ((foundation.rank === 0 && card.rank === 1 && card.suit === suit) ||
        (foundation.rank > 0 && foundation.rank === card.rank - 1 && card.suit === suit)) {
      return { kind: "waste-foundation", suit };
    }
  }
  return null;
}

const revealIsAnimating = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="solitaire-card-"] > span')].some(
      (el) => getComputedStyle(el).animationName === "gr-card-reveal",
    ),
  );

const boardPly = (page) =>
  page.$eval('[data-testid="solitaire-board"]', (el) => Number(el.dataset.ply));

const drawClicks = async (page, times) => {
  for (let i = 0; i < times; i += 1) {
    await page.click('[data-testid="solitaire-stock"]');
    await page.waitForTimeout(420);
  }
};

/** Start Solo (or Daily) and play one legal card placement. */
async function playOnePlacement(page, startSelector) {
  await page.click(startSelector);
  await page.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
  await page.waitForTimeout(400);

  let columns = await COLUMNS(page);
  let move = findTableauMove(columns);
  let wasteMove = move ? null : await findWasteMove(page, columns);
  // Deal-dependent: turn the stock until a legal move appears.
  for (let attempt = 0; !move && !wasteMove && attempt < 6; attempt += 1) {
    await drawClicks(page, 1);
    columns = await COLUMNS(page);
    move = findTableauMove(columns);
    wasteMove = move ? null : await findWasteMove(page, columns);
  }

  if (move) {
    const before = await boardPly(page);
    await page.click(`[data-testid="solitaire-card-${move.srcColumn}-${move.srcIndex}"]`);
    await page.waitForTimeout(100);
    const target =
      move.placement.kind === "empty"
        ? `[data-testid="solitaire-column-${move.dstColumn}-empty"]`
        : `[data-testid="solitaire-card-${move.dstColumn}-${move.placement.index}"]`;
    await page.click(target);
    await page.waitForTimeout(70);
    const revealed = await revealIsAnimating(page);
    await page.waitForTimeout(400);
    return { moved: (await boardPly(page)) > before, reveals: move.reveals, revealed };
  }

  if (wasteMove) {
    const before = await boardPly(page);
    await page.click('[data-testid="solitaire-waste-top"]');
    await page.waitForTimeout(100);
    if (wasteMove.kind === "waste-foundation") {
      await page.click(`[data-testid="solitaire-foundation-${wasteMove.suit}"]`);
    } else if (wasteMove.placement.kind === "empty") {
      await page.click(`[data-testid="solitaire-column-${wasteMove.dstColumn}-empty"]`);
    } else {
      await page.click(
        `[data-testid="solitaire-card-${wasteMove.dstColumn}-${wasteMove.placement.index}"]`,
      );
    }
    await page.waitForTimeout(470);
    return { moved: (await boardPly(page)) > before, reveals: false, revealed: false };
  }

  return { moved: false, reveals: false, revealed: false, reason: "no legal move found" };
}

// ── 1. Real Solo game ─────────────────────────────────────────────────────
const soloContext = await browser.newContext({ viewport: { width: 1280, height: 960 } });
await soloContext.addInitScript(instrument);
const solo = await soloContext.newPage();
const soloErrors = watchErrors(solo);
await solo.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await solo.waitForSelector('button:has-text("New game")', { timeout: 60_000 });
check("solo: the real route offers a new game", true);

await solo.click('button:has-text("New game")');
await solo.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
await solo.waitForTimeout(400);
check(
  "solo: a real 28-card Klondike deal is on screen",
  (await solo.locator('[data-testid^="solitaire-card-"]').count()) === 28,
);
await solo.screenshot({ path: join(REPORTS, "live-solo-deal.png") });

const stockBefore = Number(await solo.getAttribute('[data-testid="solitaire-stock"]', "data-remaining"));
await solo.click('[data-testid="solitaire-stock"]');
await solo.waitForTimeout(100);
const drawAnimation = await solo.$eval('[data-testid="solitaire-waste-top"]', (el) => {
  const inner = el.querySelector(":scope > span");
  return {
    outer: getComputedStyle(el).animationName,
    inner: inner ? getComputedStyle(inner).animationName : "none",
  };
});
check(
  "solo: a real stock click plays the draw-and-flip",
  drawAnimation.outer === "gr-card-draw-translate" && drawAnimation.inner === "gr-card-draw-flip",
  JSON.stringify(drawAnimation),
);
check(
  "solo: the stock count is the engine's own",
  Number(await solo.getAttribute('[data-testid="solitaire-stock"]', "data-remaining")) === stockBefore - 1,
);
await solo.waitForTimeout(450);

const placement = await playOnePlacementFromBoard(solo);
check("solo: a real click-to-place move is accepted", placement.moved, placement.reason ?? "");
check("solo: a placement plays the shared card cue", await playedPlacementCue(solo));
if (placement.reveals) {
  check("solo: the move flips the uncovered card", placement.revealed);
}
await solo.screenshot({ path: join(REPORTS, "live-solo-after-move.png") });
check("solo: no runtime errors", soloErrors.length === 0, soloErrors.join("; "));
await soloContext.close();

// A placement on an already-started board (the helper above starts its own).
async function playOnePlacementFromBoard(page) {
  let columns = await COLUMNS(page);
  let move = findTableauMove(columns);
  let wasteMove = move ? null : await findWasteMove(page, columns);
  // A fresh deal may show no tableau move: turn the stock until one appears,
  // exactly as a player would.
  for (let attempt = 0; !move && !wasteMove && attempt < 8; attempt += 1) {
    await drawClicks(page, 1);
    columns = await COLUMNS(page);
    move = findTableauMove(columns);
    wasteMove = move ? null : await findWasteMove(page, columns);
  }
  if (!move && !wasteMove) {
    return { moved: false, reveals: false, revealed: false, reason: "no legal move found" };
  }
  if (!move && wasteMove) {
      const before = await boardPly(page);
      await page.click('[data-testid="solitaire-waste-top"]');
      await page.waitForTimeout(100);
      if (wasteMove.kind === "waste-foundation") {
        await page.click(`[data-testid="solitaire-foundation-${wasteMove.suit}"]`);
      } else if (wasteMove.placement.kind === "empty") {
        await page.click(`[data-testid="solitaire-column-${wasteMove.dstColumn}-empty"]`);
      } else {
        await page.click(
          `[data-testid="solitaire-card-${wasteMove.dstColumn}-${wasteMove.placement.index}"]`,
        );
      }
      await page.waitForTimeout(470);
      return { moved: (await boardPly(page)) > before, reveals: false, revealed: false };
  }
  const before = await boardPly(page);
  await page.click(`[data-testid="solitaire-card-${move.srcColumn}-${move.srcIndex}"]`);
  await page.waitForTimeout(100);
  const target =
    move.placement.kind === "empty"
      ? `[data-testid="solitaire-column-${move.dstColumn}-empty"]`
      : `[data-testid="solitaire-card-${move.dstColumn}-${move.placement.index}"]`;
  await page.click(target);
  await page.waitForTimeout(70);
  const revealed = await revealIsAnimating(page);
  await page.waitForTimeout(400);
  return { moved: (await boardPly(page)) > before, reveals: move.reveals, revealed };
}

// ── 2. Muted: the same placement is silent ────────────────────────────────
const mutedContext = await browser.newContext({ viewport: { width: 1280, height: 960 } });
await mutedContext.addInitScript(instrument);
await mutedContext.addInitScript(() => {
  try {
    localStorage.setItem("grynd_audio_muted", "1");
  } catch {
    // Storage can be unavailable in a locked-down context; audio is then off
    // only via the context gate, which the assertion below still covers.
  }
});
const muted = await mutedContext.newPage();
const mutedErrors = watchErrors(muted);
await muted.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await muted.waitForSelector('button:has-text("New game")', { timeout: 60_000 });
await muted.click('button:has-text("New game")');
await muted.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
await muted.waitForTimeout(400);
const mutedPlacement = await playOnePlacementFromBoard(muted);
check("mute: the real placement still moves the card", mutedPlacement.moved);
check("mute: no placement cue is scheduled", !(await playedPlacementCue(muted)));
check("mute: no runtime errors", mutedErrors.length === 0, mutedErrors.join("; "));
await mutedContext.close();

// ── 3. Reduced motion: sound and flips both stay still ────────────────────
const reducedContext = await browser.newContext({
  viewport: { width: 1280, height: 960 },
  reducedMotion: "reduce",
});
await reducedContext.addInitScript(instrument);
const reduced = await reducedContext.newPage();
const reducedErrors = watchErrors(reduced);
await reduced.goto(`${BASE}/solitaire`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await reduced.waitForSelector('button:has-text("New game")', { timeout: 60_000 });
await reduced.click('button:has-text("New game")');
await reduced.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
await reduced.waitForTimeout(400);
const reducedPlacement = await playOnePlacementFromBoard(reduced);
check("reduced motion: the real placement still moves the card", reducedPlacement.moved);
check("reduced motion: no placement cue is scheduled", !(await playedPlacementCue(reduced)));
check(
  "reduced motion: the board reports no reveal animation",
  !(await revealIsAnimating(reduced)),
);
check("reduced motion: no runtime errors", reducedErrors.length === 0, reducedErrors.join("; "));
await reducedContext.close();

// ── 4. The real Daily Challenge ───────────────────────────────────────────
const dailyContext = await browser.newContext({ viewport: { width: 1280, height: 960 } });
await dailyContext.addInitScript(instrument);
const daily = await dailyContext.newPage();
const dailyErrors = watchErrors(daily);
await daily.goto(`${BASE}/daily`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const dailyStart = daily.locator('button', { hasText: /Start challenge|Replay as practice/ }).first();
const dailyFailed = daily.locator("text=Today's deal could not be loaded");
await Promise.race([
  dailyStart.waitFor({ state: "visible", timeout: 60_000 }),
  dailyFailed.waitFor({ state: "visible", timeout: 60_000 }),
]).catch(() => {});

if (await dailyStart.isVisible().catch(() => false)) {
  check("daily: the server's deal is offered", true);
  await dailyStart.click();
  await daily.waitForSelector('[data-testid="solitaire-board"]', { timeout: 30_000 });
  await daily.waitForTimeout(400);
  check(
    "daily: the real challenge deals 28 cards",
    (await daily.locator('[data-testid^="solitaire-card-"]').count()) === 28,
  );
  await daily.click('[data-testid="solitaire-stock"]');
  await daily.waitForTimeout(100);
  check(
    "daily: a stock draw animates on the real server deal",
    (await daily.$eval('[data-testid="solitaire-waste-top"]', (el) =>
      getComputedStyle(el).animationName,
    )) === "gr-card-draw-translate",
  );
  await daily.waitForTimeout(450);
  const dailyMove = await playOnePlacementFromBoard(daily);
  check("daily: a real placement is accepted", dailyMove.moved);
  check("daily: the placement cue plays", await playedPlacementCue(daily));
  await daily.screenshot({ path: join(REPORTS, "live-daily.png") });
} else {
  const reason = (await daily.textContent("body"))?.slice(0, 160) ?? "";
  check("daily: today's server deal is playable", false, reason.replace(/\s+/g, " "));
}
check("daily: no runtime errors", dailyErrors.length === 0, dailyErrors.join("; "));
await dailyContext.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
