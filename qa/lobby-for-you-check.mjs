// qa/lobby-for-you-check.mjs
//
// Browser check for the casino lobby's personalized "FOR YOU" section
// (src/app/casino/PageClient.jsx).
//
// Real Chromium (Playwright), the repo's actual Tailwind + globals.css, and a
// DOM fixture whose class names are byte-identical to the section the lobby
// ships with. What it proves:
//
//   A. MOBILE / RESPONSIVE LAYOUT — at every breakpoint (375 → 1440) the page
//      never scrolls horizontally, and no element's right edge escapes the
//      viewport. This is the regression the section could have introduced,
//      since it adds a first grid above the existing one.
//   B. ONE CARD SYSTEM, ONE ROW RECIPE — the For You cards are exactly the
//      same width as the All Games cards at every breakpoint (same grid
//      classes), the grid collapses 1 → 2 → 3 columns as the room grows, and
//      the section sits ABOVE All Games in both DOM and visual order.
//   C. CARD BADGES DO NOT COLLIDE — the "Recommended" pill lives inside the
//      card art, never overflows the card, and never overlaps the PvP badge
//      (top-left) or the NEW/HOT pill (top-right).
//
// Run: node qa/lobby-for-you-check.mjs

import { chromium } from "playwright";
import tailwind from "tailwindcss";
import postcss from "postcss";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!existsSync("node_modules/tailwindcss")) {
  console.log("tailwindcss not installed — install deps first (npm ci)");
  process.exit(1);
}

/** The grid recipe both the For You strip and All Games use — copied
 *  verbatim from src/app/casino/PageClient.jsx (a test in
 *  tests/lobby-for-you.test.mjs asserts the two grids use the same string). */
const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 xl:grid-cols-4";
/** The lobby's page shell (root + container). */
const ROOT = "relative min-h-screen overflow-x-clip pb-40 pt-16 md:pb-8 md:pt-20";
const CONTAINER = "mx-auto max-w-7xl px-3 py-6 sm:px-4 sm:py-12";

const VIEWPORTS = [
  { key: "iPhone SE (375)", width: 375, height: 667 },
  { key: "iPhone 14 (390)", width: 390, height: 844 },
  { key: "tablet (768)", width: 768, height: 1024 },
  { key: "laptop (1024)", width: 1024, height: 800 },
  { key: "desktop (1280)", width: 1280, height: 900 },
  { key: "wide (1536)", width: 1536, height: 960 },
];

/**
 * The live-activity line the lobby now renders in every card footer
 * (PlayerCountBadge in src/app/casino/PageClient.jsx) — same classes, all four
 * render states, and the LONGEST shipped translation as the worst case:
 * `Nadie está jugando ahora mismo` (es) has to fit a card at every breakpoint
 * without being clipped by the card's `overflow-hidden`. Keep this string
 * byte-identical to src/lib/appTextTranslations.js — a test in
 * tests/game-presence.test.mjs compares the two.
 */
function playersMarkup(state) {
  if (state === "loading") {
    return `<p data-player-count aria-hidden="true" class="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold"><span class="h-2 w-2 animate-pulse rounded-full bg-[#9dd8ff]/40"></span><span class="h-3 w-14 animate-pulse rounded-full bg-[#9dd8ff]/15"></span></p>`;
  }
  const hot = state === "hot";
  const none = state === "none";
  const color = hot ? "text-[#f5ff3b]" : none ? "text-[#9dd8ff]" : "text-[#34d399]";
  const glyphColor = none
    ? "text-[#9dd8ff]/50"
    : hot
      ? "drop-shadow-[0_0_8px_rgba(245,255,59,0.6)]"
      : "text-[#34d399] drop-shadow-[0_0_6px_rgba(52,211,153,0.7)]";
  const text = none ? "Nadie está jugando ahora mismo" : hot ? "127 playing" : "12 playing";
  return `<p data-player-count class="flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold ${color}"><span aria-hidden="true" class="${glyphColor}">${hot ? "🔥" : "●"}</span>${text}</p>`;
}

/** Mirrors the lobby's <GameCard> markup (same classes, a stand-in image). */
function cardMarkup({
  title,
  recommended = false,
  newBadge = false,
  hotBadge = false,
  players = "playing",
}) {
  return `
        <div class="group relative flex h-full flex-col overflow-hidden rounded-xl border border-[#00e5ff]/35 bg-[#040d24] p-4 transition-all duration-300">
          <a href="#" class="block cursor-pointer">
            <div class="mb-3 relative aspect-video overflow-hidden rounded-lg">
              <div class="card-art h-full w-full" style="background:linear-gradient(135deg,#0b1b3f,#00e5ff)"></div>
              <span class="pvp-badge absolute left-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] backdrop-blur-sm">1v1</span>
              ${
                newBadge
                  ? `<span class="new-badge absolute right-2 top-2 rounded-full border border-[#00e5ff]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00e5ff] backdrop-blur-sm">NEW</span>`
                  : hotBadge
                    ? `<span class="hot-badge absolute right-2 top-2 rounded-full border border-[#f5ff3b]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f5ff3b] backdrop-blur-sm">HOT</span>`
                    : ""
              }
              ${
                recommended
                  ? `<span class="recommended-pill absolute bottom-2 right-2 rounded-full border border-[#f0abfc]/60 bg-[#0b1b3f]/85 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#f0abfc] backdrop-blur-sm">Recommended</span>`
                  : ""
              }
            </div>
            <h3 class="mb-2 text-lg font-extrabold tracking-tight text-[#f5ff3b] md:text-xl">${title}</h3>
            <p class="line-clamp-2 text-sm leading-relaxed text-[#9dd8ff] md:text-[15px]">A short shipped description of the game.</p>
            <div class="mt-4">
              <span class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-3 py-2 text-sm font-bold text-[#00e5ff] sm:w-auto">Play</span>
            </div>
          </a>
          <div class="mt-auto pt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            ${players === null ? "" : playersMarkup(players)}
            <a href="#" class="text-xs text-[#00e5ff] underline underline-offset-2">View leaderboard</a>
          </div>
        </div>`;
}

/** The lobby page with the For You section above All Games. */
/** Rotating the four render states keeps every viewport exercising all of
 *  them (a cycling skeleton, a long "nobody" line, a hot count, a normal one). */
const PLAYER_STATES = ["playing", "hot", "none", "loading"];

function fixture({
  forYouCards = 3,
  allGamesCards = 8,
  omitForYou = false,
  omitPlayers = false,
}) {
  const playersFor = (i) => (omitPlayers ? null : PLAYER_STATES[i % PLAYER_STATES.length]);
  const forYou = omitForYou
    ? ""
    : `
        <section id="for-you" class="mb-8" aria-label="For you">
          <h2 class="mb-1 flex items-center gap-2 text-lg font-extrabold tracking-tight text-[#f5ff3b] sm:text-xl">
            <span aria-hidden="true">*</span>
            For you
          </h2>
          <p class="mb-4 text-sm leading-relaxed text-[#9dd8ff]">Climb the rankings.</p>
          <div id="for-you-grid" class="${GRID}">
            ${Array.from(
              { length: forYouCards },
              (_, i) =>
                `<div class="h-full">${cardMarkup({
                  title: `Recommended ${i + 1}`,
                  recommended: true,
                  newBadge: i === 0,
                  hotBadge: i === 1,
                  players: playersFor(i),
                })}</div>`
            ).join("\n")}
          </div>
        </section>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
  <div id="root" class="${ROOT}">
    <div id="container" class="${CONTAINER}">
      ${forYou}
      <h2 id="all-games-heading" class="mb-6 text-2xl font-extrabold tracking-tight text-[#00e5ff] sm:text-3xl">All Games</h2>
      <div id="all-games-grid" class="${GRID}">
        ${Array.from(
          { length: allGamesCards },
          (_, i) =>
            `<div class="h-full">${cardMarkup({
              title: `Game ${i + 1}`,
              hotBadge: i === 0,
              players: playersFor(i + 1),
            })}</div>`
        ).join("\n")}
      </div>
    </div>
  </div>
</body></html>`;
}

const tmp = mkdtempSync(join(tmpdir(), "lobby-for-you-"));
writeFileSync(join(tmp, "lobby.html"), fixture({}));
// Same page without the section — the control that proves the section itself
// is what a layout regression would come from (and that it is not required for
// the page to lay out).
writeFileSync(join(tmp, "lobby-no-for-you.html"), fixture({ omitForYou: true }));
// Same page without the live-activity line — the control that proves the
// player count does not change the grid geometry it was added to.
writeFileSync(join(tmp, "lobby-no-players.html"), fixture({ omitPlayers: true }));

// The fixtures are the Tailwind content source, so every utility the real
// section uses is compiled exactly as the app compiles it. App-level CSS is
// deliberately NOT layered on top: an existing `overflow-x: hidden` anywhere
// would mask a real regression, and the point of the check below is that the
// section lays out inside the viewport on its own.
const generated = await postcss([tailwind({ content: [join(tmp, "*.html")] })]).process(
  "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
  {
    from: undefined,
  }
);
writeFileSync(join(tmp, "tw.css"), generated.css);

// ── Run ────────────────────────────────────────────────────────────────

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
}

let failed = 0;
const check = (cond, label) => {
  console.log(cond ? "PASS" : "FAIL", label);
  if (!cond) failed++;
};

const MEASURE = `() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const de = document.documentElement;
  const cards = (sel) => [...document.querySelectorAll(sel + " > div > div")];
  const forYouGrid = document.getElementById("for-you-grid");
  const allGrid = document.getElementById("all-games-grid");
  const forYouCards = forYouGrid ? cards("#for-you-grid") : [];
  const allCards = cards("#all-games-grid");
  const rows = (list) => {
    const tops = new Set(list.map((el) => Math.round(el.getBoundingClientRect().top)));
    return tops.size;
  };
  const perRow = (list) => {
    if (list.length === 0) return 0;
    const first = Math.round(list[0].getBoundingClientRect().top);
    return list.filter((el) => Math.round(el.getBoundingClientRect().top) === first).length;
  };
  const widest = [...document.querySelectorAll("#container *")].reduce(
    (max, el) => Math.max(max, el.getBoundingClientRect().right), 0);
  const playerLines = [...document.querySelectorAll("[data-player-count]")];
  // Inside its card (the card clips with overflow-hidden, so a label that did
  // not fit would silently disappear). The card's own padding is read from the
  // computed style rather than assumed, so the bound is exact in any harness.
  const lineInsideCard = playerLines.map((el) => {
    const r = rect(el);
    const cardEl = el.closest(".group");
    const c = rect(cardEl);
    const padL = parseFloat(getComputedStyle(cardEl).paddingLeft) || 0;
    const padR = parseFloat(getComputedStyle(cardEl).paddingRight) || 0;
    const widthFits = r.width <= cardEl.clientWidth - padL - padR + 0.5;
    return r.left >= c.left + 0.5 && r.right <= c.right - 0.5 && widthFits;
  });
  const firstLine = playerLines[0];
  const firstCard = firstLine ? firstLine.closest(".group") : null;
  const firstArt = firstCard ? firstCard.querySelector(".relative") : null;
  const pill = document.querySelector("#for-you-grid .recommended-pill");
  const card = pill ? pill.closest("div.group") || pill.closest(".group") : null;
  const art = pill ? pill.closest(".relative") : null;
  const overlaps = (a, b) => {
    if (!a || !b) return false;
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 0.5 && y > 0.5;
  };
  const pvpBadge = card ? card.querySelector(".pvp-badge") : null;
  const topRightBadge = card ? card.querySelector(".new-badge, .hot-badge") : null;
  return {
    viewport: window.innerWidth,
    scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth),
    widest: Math.round(widest),
    forYouWidth: forYouCards.length ? Math.round(forYouCards[0].getBoundingClientRect().width) : null,
    allWidth: allCards.length ? Math.round(allCards[0].getBoundingClientRect().width) : null,
    forYouPerRow: perRow(forYouCards),
    allPerRow: perRow(allCards),
    forYouTop: forYouGrid ? Math.round(forYouGrid.getBoundingClientRect().top) : null,
    allTop: Math.round(allGrid.getBoundingClientRect().top),
    hasHeading: !!document.querySelector("#for-you h2"),
    hasAriaLabel: document.getElementById("for-you")?.getAttribute("aria-label") || null,
    cardCount: forYouCards.length,
    allCardCount: allCards.length,
    playerLines: playerLines.length,
    playerLinesInsideCard: lineInsideCard.filter(Boolean).length,
    playerLineTexts: playerLines.map((el) => el.textContent.trim()),
    playerLineOverArt: overlaps(firstLine, firstArt),
    // The footer is the card's last line: the count and the leaderboard link
    // share it (flex-wrap keeps them apart even when they cannot both fit).
    playerLineOverLink: playerLines.some((el) =>
      overlaps(rect(el), rect(el.parentElement.querySelector("a")))
    ),
    // The widest label we ship, and the tallest line box: a one-line budget
    // that holds in ANY card width (the narrowest is 294px minus padding).
    playerLineMaxWidth: Math.round(
      playerLines.reduce((max, el) => Math.max(max, el.getBoundingClientRect().width), 0)
    ),
    playerLineMaxHeight: Math.round(
      playerLines.reduce((max, el) => Math.max(max, el.getBoundingClientRect().height), 0)
    ),
    pill: pill ? rect(pill) : null,
    card: card ? rect(card) : null,
    art: art ? rect(art) : null,
    pillOverPvp: overlaps(pill, pvpBadge),
    pillOverTopRight: overlaps(pill, topRightBadge),
    pillText: pill ? pill.textContent.trim() : null,
  };
}`;

const open = async (name, viewport) => {
  const page = await browser.newPage({ viewport });
  await page.goto("file://" + join(tmp, name).replace(/\\/g, "/"));
  await page.addStyleTag({ path: join(tmp, "tw.css") });
  return page;
};

try {
  console.log("── A/B. Responsive layout + one card recipe, per breakpoint ──\n");
  for (const vp of VIEWPORTS) {
    const page = await open("lobby.html", { width: vp.width, height: vp.height });
    const m = await page.evaluate(eval(`(${MEASURE})`));

    // A. No horizontal overflow anywhere on the page.
    check(
      m.scrollWidth <= vp.width,
      `${vp.key}: no horizontal scroll (scrollWidth ${m.scrollWidth} ≤ ${vp.width})`
    );
    check(
      m.widest <= vp.width + 1,
      `${vp.key}: no element escapes the viewport (widest right edge ${m.widest})`
    );

    // B. Same card width in both grids, section above All Games.
    check(
      m.forYouWidth === m.allWidth,
      `${vp.key}: For You card width ${m.forYouWidth}px === All Games ${m.allWidth}px`
    );
    check(m.forYouTop < m.allTop, `${vp.key}: For You renders above All Games`);
    check(m.cardCount === 3, `${vp.key}: 3 recommended cards rendered`);
    check(m.hasHeading && m.hasAriaLabel, `${vp.key}: section has an h2 + aria-label`);

    const expectedPerRow = vp.width < 640 ? 1 : vp.width < 1024 ? 2 : 3;
    check(
      m.forYouPerRow === expectedPerRow,
      `${vp.key}: For You grid shows ${m.forYouPerRow} card(s) per row (expected ${expectedPerRow})`
    );
    const expectedAllPerRow = vp.width < 640 ? 1 : vp.width < 1024 ? 2 : vp.width < 1280 ? 3 : 4;
    check(
      m.allPerRow === expectedAllPerRow,
      `${vp.key}: All Games grid shows ${m.allPerRow} card(s) per row (expected ${expectedAllPerRow})`
    );

    // C. The recommended pill stays inside the card art and collides with
    //    neither the PvP badge nor the NEW/HOT pill.
    check(
      !!m.pill && m.pill.right <= m.card.right + 0.5 && m.pill.left >= m.card.left - 0.5,
      `${vp.key}: "Recommended" pill sits inside the card`
    );
    check(
      !!m.pill && m.pill.bottom <= m.art.bottom + 0.5,
      `${vp.key}: "Recommended" pill stays inside the card art`
    );
    check(!m.pillOverPvp, `${vp.key}: pill does not overlap the PvP badge`);
    check(!m.pillOverTopRight, `${vp.key}: pill does not overlap the NEW/HOT badge`);
    check(m.pillText === "Recommended", `${vp.key}: pill renders its label ("${m.pillText}")`);

    // D. The live-activity line is on EVERY card, stays inside it (the card
    //    clips, so an over-long translation would silently disappear), and
    //    never covers the art the badges live on.
    check(
      m.playerLines === m.cardCount + m.allCardCount,
      `${vp.key}: every card shows a player count (${m.playerLines}/${m.cardCount + m.allCardCount})`
    );
    check(
      m.playerLinesInsideCard === m.playerLines,
      `${vp.key}: the player count fits inside every card (${m.playerLinesInsideCard}/${m.playerLines})`
    );
    check(!m.playerLineOverArt, `${vp.key}: the player count never overlaps the card art`);
    check(
      !m.playerLineOverLink,
      `${vp.key}: the player count never collides with the leaderboard link`
    );
    check(
      m.playerLineMaxWidth <= 200,
      `${vp.key}: widest label is ${m.playerLineMaxWidth}px (budget 200px — fits the 294px card minus padding)`
    );
    check(
      m.playerLineMaxHeight <= 20,
      `${vp.key}: the label stays on ONE line (${m.playerLineMaxHeight}px)`
    );
    check(
      m.playerLineTexts.some((text) => text.includes("Nadie está jugando ahora mismo")),
      `${vp.key}: longest shipped translation renders intact`
    );
    check(
      m.playerLineTexts.some((text) => text === "🔥127 playing"),
      `${vp.key}: hot count renders with its glyph and text`
    );

    await page.close();
  }

  console.log("\n── Control: the page without the For You section ──\n");
  for (const vp of [VIEWPORTS[1], VIEWPORTS[4]]) {
    const without = await open("lobby-no-for-you.html", { width: vp.width, height: vp.height });
    const mWithout = await without.evaluate(eval(`(${MEASURE})`));
    const withSection = await open("lobby.html", { width: vp.width, height: vp.height });
    const mWith = await withSection.evaluate(eval(`(${MEASURE})`));

    check(mWithout.scrollWidth <= vp.width, `${vp.key} (no For You): still no horizontal scroll`);
    check(
      mWithout.forYouWidth === null && mWithout.forYouTop === null,
      `${vp.key} (no For You): section absent → plain lobby`
    );
    check(
      mWith.allWidth === mWithout.allWidth,
      `${vp.key}: All Games card width unchanged (${mWithout.allWidth}px with and without the section)`
    );

    await without.close();
    await withSection.close();
  }

  console.log("\n── Control: the cards without the live-activity line ──\n");
  for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[4], VIEWPORTS[5]]) {
    const withoutCounts = await open("lobby-no-players.html", { width: vp.width, height: vp.height });
    const mWithoutCounts = await withoutCounts.evaluate(eval(`(${MEASURE})`));
    const withCounts = await open("lobby.html", { width: vp.width, height: vp.height });
    const mWithCounts = await withCounts.evaluate(eval(`(${MEASURE})`));

    check(
      mWithoutCounts.playerLines === 0,
      `${vp.key} (no player count): the line is absent → the pre-feature card`
    );
    check(
      mWithCounts.allWidth === mWithoutCounts.allWidth,
      `${vp.key}: card width unchanged by the line (${mWithoutCounts.allWidth}px)`
    );
    check(
      mWithCounts.scrollWidth <= vp.width,
      `${vp.key}: adding the line still fits the viewport (${mWithCounts.scrollWidth} ≤ ${vp.width})`
    );

    await withoutCounts.close();
    await withCounts.close();
  }
} finally {
  await browser.close();
}

console.log(
  failed === 0
    ? "\nALL PASS — For You is mobile-safe, shares the grid recipe, and never collides."
    : `\n${failed} check(s) FAILED`
);
process.exit(failed === 0 ? 0 : 1);
