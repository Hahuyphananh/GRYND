// qa/lobby-layout-shots.mjs
//
// Screenshots every casino lobby's hero + match panel at a laptop width, and
// measures whether the LEFT block (kicker, title, description, actions) starts
// on the same TOP edge as the RIGHT panel. That alignment is the thing that was
// wrong: the shared chrome used `lg:items-end`, so the short hero was dropped
// down to meet the bottom of a much taller facts/queue panel.
//
// The lobbies are the /games/<slug>/play URLs (rewritten to /casino/<slug>);
// /games/<slug> on its own is the public landing page, not the lobby.
//
// Writes screenshots/lobbies/<game>-desktop.png (1440×900) for every lobby and
// screenshots/lobbies/<game>-mobile.png (390×844) for the ones whose narrow
// layout is worth reviewing.
//
// The server must already be running:
//   npx next dev -p 3210        (or: BASE=http://localhost:3000 node qa/…)
//
// Run: node qa/lobby-layout-shots.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE || "http://localhost:3210";
// Laptop sizes matter here: the two-column layer starts at Tailwind's `lg`
// (1024px), so 1440 is the roomy case and 1366×768 the common tight one.
const WIDTH = Number(process.env.WIDTH || 1440);
const HEIGHT = Number(process.env.HEIGHT || 900);
const SHOT_SUFFIX = process.env.SHOT_SUFFIX || "desktop";
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "screenshots",
  "lobbies",
);
mkdirSync(OUT, { recursive: true });

/** Every lobby that mounts the shared chrome. */
const GAMES = [
  "four-in-a-row",
  "dots-and-boxes",
  "uno",
  "hex-duel",
  "tic-tac-toe",
  "dominoes",
  "hillstrike",
  "barrier-blitz",
  "speed-typing",
  "mini-golf",
  "rps",
  "precision",
  "tower-arena",
  "pool-masters",
  "keno",
  "lane-runner",
  "memory-grid",
  "mines-pvp",
  "solitaire-duel",
  "sudoku-duel",
  "odds",
];

/** Lobbies whose narrow layout deserves its own look. */
const MOBILE = ["four-in-a-row", "uno", "hillstrike"];

/** Anything above this many pixels is a visible misalignment, not rounding. */
const TOLERANCE_PX = 2;

const browser = await chromium.launch({ channel: "chrome", headless: true });

const newContext = async (options) => {
  const context = await browser.newContext({ deviceScaleFactor: 1, ...options });
  // The splash is a once-per-session brand moment that covers the viewport; mark
  // it as seen (what an in-app navigation does) so the shot is of the lobby.
  await context.addInitScript(() => {
    try {
      window.sessionStorage.setItem("grynd:splash:seen:v1", "1");
      // Consent already recorded, so the cookie strip never renders over the
      // fold in the shot (src/lib/cookieConsent.ts).
      window.localStorage.setItem("grynd_cookie_consent", "accepted");
    } catch {
      /* storage unavailable — the splash clears itself on its own timer */
    }
  });
  return context;
};

/**
 * The grid that holds the hero and the panel, and the two boxes we compare.
 *
 * Read from the DOM rather than hard-coded, so the same measurement works for
 * the shared chrome AND for a lobby that lays itself out on its own.
 */
const MEASURE = () => {
  const section = [...document.querySelectorAll("section")].find((node) => {
    const cls = node.className || "";
    const children = [...node.children];
    return cls.includes("lg:grid-cols") && children.length >= 2;
  });
  if (!section) return null;
  const [left, right] = [...section.children];
  const a = left.getBoundingClientRect();
  const b = right.getBoundingClientRect();
  return {
    leftTop: Math.round(a.top),
    rightTop: Math.round(b.top),
    leftBottom: Math.round(a.bottom),
    rightBottom: Math.round(b.bottom),
    stacked: b.top >= a.bottom - 1,
  };
};

/** Dismiss the cookie strip so it cannot cover the fold in a screenshot. */
async function dismissBanner(page) {
  for (const label of ["Accept", "Decline"]) {
    const button = page.locator(`button:has-text("${label}")`).first();
    if (await button.count()) {
      try {
        await button.click({ timeout: 1500 });
        return;
      } catch {
        /* not clickable — the shot below still works */
      }
    }
  }
}

async function openLobby(page, game) {
  await page.goto(`${BASE}/games/${game}/play`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("section")].some((node) =>
        String(node.className || "").includes("lg:grid-cols"),
      ),
    null,
    { timeout: 30000 },
  );
  await dismissBanner(page);
  // Development-only Next overlay (it reports Clerk/DB noise from the harness,
  // not layout) — hide it so it cannot be mistaken for a page element.
  await page
    .addStyleTag({ content: "nextjs-portal{display:none!important}" })
    .catch(() => {});
  // Let the hero's mount animation settle at its final position.
  await page.waitForTimeout(700);
}

const desktopContext = await newContext({
  viewport: { width: WIDTH, height: HEIGHT },
});
const page = await desktopContext.newPage();
const rows = [];

for (const game of GAMES) {
  try {
    await openLobby(page, game);
    const measured = await page.evaluate(MEASURE);
    await page.screenshot({ path: join(OUT, `${game}-${SHOT_SUFFIX}.png`) });
    rows.push({ game, ...(measured || {}) });
    const delta = measured ? measured.leftTop - measured.rightTop : null;
    const verdict =
      measured == null
        ? "NO GRID FOUND"
        : Math.abs(delta) <= TOLERANCE_PX
          ? "aligned"
          : `OFF by ${delta}px`;
    console.log(
      `${game.padEnd(14)} left=${measured?.leftTop ?? "?"} right=${measured?.rightTop ?? "?"} → ${verdict}`,
    );
  } catch (error) {
    console.log(`${game.padEnd(14)} FAILED: ${String(error).slice(0, 140)}`);
    rows.push({ game, error: String(error).slice(0, 200) });
  }
}

const mobileContext = await newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const mobilePage = await mobileContext.newPage();
for (const game of MOBILE) {
  try {
    await openLobby(mobilePage, game);
    await mobilePage.screenshot({ path: join(OUT, `${game}-mobile.png`) });
    console.log(`mobile shot: screenshots/lobbies/${game}-mobile.png`);
  } catch (error) {
    console.log(`mobile ${game} FAILED: ${String(error).slice(0, 140)}`);
  }
}

const measured = rows.filter((row) => typeof row.leftTop === "number");
const misaligned = measured.filter(
  (row) => Math.abs(row.leftTop - row.rightTop) > TOLERANCE_PX,
);

console.log(
  `\n${measured.length}/${GAMES.length} lobbies measured · ${misaligned.length} misaligned at a laptop width` +
    (misaligned.length
      ? ` (${misaligned.map((row) => row.game).join(", ")})`
      : ""),
);

await browser.close();
process.exit(misaligned.length > 0 ? 1 : 0);
