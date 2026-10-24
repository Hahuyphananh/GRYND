/**
 * hillstrike-practice-ui.test.mjs
 *
 * The contracts the Hillstrike practice screen has to keep, pinned at the TEXT
 * level — the things a browser check cannot see cheaply:
 *
 *   • the UI owns no rule. Collisions, damage, lives, volleys and the winner come
 *     from `src/lib/hillstrike/*`; a component only draws state and reports a
 *     gesture. A drag becomes an aim through the ENGINE's `aimFromDrag`, a
 *     preview is a real `simulateShot`, a press of Fire is `applyShot`.
 *   • the canvas is fluid (aspect-ratio + ResizeObserver + device-pixel-ratio
 *     scaling), never a fixed pixel board, so it fits a phone and a desktop.
 *   • practice stays free and local: no wager, no rating, no network call.
 *   • every affordance the design asks for (lives, turn, shots left, Fire,
 *     Restart, result) has a stable hook, and the browser harness's handles
 *     stay put.
 *
 * Comments are stripped before the "must not" checks: the prose in these files
 * legitimately talks about the rules (and about not taking wagers) while the
 * CODE must not do either.
 *
 * Run:  node --import tsx --test tests/hillstrike-practice-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AI_DIFFICULTIES } from "../src/lib/aiDifficulty.ts";
import {
  DEFAULT_MAX_PULL,
  LIVES_PER_PLAYER,
  POWER_MAX,
  SHOTS_PER_VOLLEY,
} from "../src/lib/hillstrike/constants.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The same source with `//` and `/* … *​/` commentary removed. */
function stripComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

const PAGE_PATH = "src/app/casino/hillstrike/play-ai/PageClient.tsx";
const ROUTE_PATH = "src/app/casino/hillstrike/play-ai/page.tsx";
const FIELD_PATH = "src/components/hillstrike/HillstrikeBattlefield.tsx";
const HUD_PATH = "src/components/hillstrike/HillstrikeHud.tsx";
const PROXY_PATH = "src/proxy.ts";

const page = read(PAGE_PATH);
const route = read(ROUTE_PATH);
const field = read(FIELD_PATH);
const hud = read(HUD_PATH);
const proxy = read(PROXY_PATH);

const pageCode = stripComments(page);
const routeCode = stripComments(route);
const fieldCode = stripComments(field);
const hudCode = stripComments(hud);

/* -------------------------------------------------------------------------- *
 * One rulebook: the engine's
 * -------------------------------------------------------------------------- */

test("hillstrike practice: the page drives the engine and nothing else", () => {
  for (const symbol of [
    "createInitialState",
    "validateShot",
    "applyShot",
    "simulateShot",
    "chooseAiShot",
  ]) {
    assert.ok(pageCode.includes(symbol), `the page must use the engine's ${symbol}`);
  }

  // A shot is accepted by the ENGINE, from the engine's own verdict — the exact
  // shape a future server route will use.
  assert.ok(pageCode.includes("validateShot(current, seat, shot)"));
  assert.ok(pageCode.includes("applyShot(current, seat, shot)"));

  // The bot answers through the SAME two calls as the human: it is given no
  // private path into the rules.
  assert.ok(
    /fireShot\(AI_SEAT, shot\)/.test(pageCode),
    "the bot's shot must resolve through the same fireShot as the player's",
  );
  assert.ok(
    /fireShot\(HUMAN_SEAT, aim\)/.test(pageCode),
    "the player's Fire must resolve through fireShot",
  );
});

test("hillstrike practice: no component decides a collision, a life or a turn", () => {
  const forbidden = [
    // physics / rules that may only live in the engine
    "GRAVITY",
    "PROJECTILE_",
    "LIVES_PER_PLAYER =" /* a redefinition, not a read */,
    "IMPACT_KINDS.PLAYER",
    "block-destroyed",
    "lives-exhausted",
    "turnIndex =",
    "shotsRemaining =",
    "lives[",
    // no second rules implementation anywhere in the UI
    "simulateShot",
    "applyShot",
    "validateShot",
    "createInitialState",
    "createBattlefield",
  ];
  for (const [name, code] of [
    ["battlefield", fieldCode],
    ["hud", hudCode],
  ]) {
    for (const token of forbidden) {
      if (token === "lives[") {
        // Read-only access IS how the HUD renders lives; only a write is wrong.
        assert.equal(
          /lives\[[^\]]+\]\s*=[^=]/.test(code),
          false,
          `${name} must not write the engine's lives`,
        );
        continue;
      }
      assert.equal(
        code.includes(token),
        false,
        `${name} must not contain engine logic (found ${token})`,
      );
    }
  }

  // …and the page never mutates it either.
  for (const fieldName of ["lives", "turn", "shotsRemaining", "winner", "status"]) {
    assert.equal(
      new RegExp(`state\\.${fieldName}\\s*=[^=]`).test(pageCode),
      false,
      `the page must not write state.${fieldName}`,
    );
    assert.equal(
      new RegExp(`match\\.${fieldName}\\s*=[^=]`).test(pageCode),
      false,
      `the page must not write match.${fieldName}`,
    );
  }
});

test("hillstrike practice: a drag is converted by the engine, not by the view", () => {
  assert.ok(fieldCode.includes("aimFromDrag"), "the gesture uses the engine's conversion");
  for (const local of ["Math.atan2", "Math.atan", "Math.acos", "Math.asin"]) {
    assert.equal(
      fieldCode.includes(local),
      false,
      `the battlefield must not re-derive an angle itself (found ${local})`,
    );
  }
  // The aim is reported upward; the page is the only place that acts on it.
  assert.ok(fieldCode.includes("onAim("), "a drag reports an aim upward");
  assert.ok(fieldCode.includes("onLock("), "a release locks the aim upward");
  assert.ok(pageCode.includes("onAim={(shot) =>"), "the page receives the aim");
  assert.ok(pageCode.includes("onLock={(shot) =>"), "the page receives the locked aim");
});

test("hillstrike practice: the preview is the engine's own resolution of the aim", () => {
  assert.ok(
    pageCode.includes("simulateShot({") && pageCode.includes("shot: aim"),
    "the preview must be a real simulation of the pending aim",
  );
  assert.ok(
    /return \{ path: simulation\.path, impact: simulation\.impact \}/.test(pageCode),
    "the preview is the simulation's own path and impact",
  );
  // The battlefield only DRAWS the preview it is handed.
  assert.ok(fieldCode.includes("preview.path.forEach") || fieldCode.includes("preview.path"));
  assert.ok(fieldCode.includes("preview.impact"));
});

/* -------------------------------------------------------------------------- *
 * Rules the UI must READ, never duplicate
 * -------------------------------------------------------------------------- */

test("hillstrike practice: lives, volleys and shot limits come from the constants", () => {
  assert.ok(
    hudCode.includes("LIVES_PER_PLAYER"),
    "the HUD draws its pip row from the engine's life count",
  );
  assert.equal(/\b3\b\s*(lives|\/\s*3)/.test(hudCode), false, "no hard-coded life total");
  assert.equal(
    /SHOTS_PER_VOLLEY|shotsRemaining\s*[-+*/]/.test(pageCode),
    false,
    "the page must never compute the volley itself",
  );
  // The values the HUD shows are the state's own.
  for (const read of ["state.lives[seat]", "state.shotsRemaining", "state.turn === seat"]) {
    assert.ok(hudCode.includes(read), `the HUD must render ${read}`);
  }
  assert.ok(pageCode.includes("TICK_MS"), "the flight time is derived from the engine's tick");
  assert.equal(LIVES_PER_PLAYER, 3);
  assert.equal(SHOTS_PER_VOLLEY, 2);
});

test("hillstrike practice: the difficulty changes only the bot's aim search", () => {
  assert.ok(pageCode.includes('from "../../../../lib/hillstrike/ai"'));
  assert.ok(pageCode.includes("chooseAiShot({"));
  assert.ok(pageCode.includes("difficulty,"), "the tier is handed to the bot's planner");
  assert.ok(pageCode.includes("HILLSTRIKE_TIER_HINTS"), "each tier explains itself");
  assert.ok(pageCode.includes('gameKey="hillstrike"'), "the shared picker is scoped per game");
  assert.ok(
    pageCode.includes("readStoredAiDifficulty(\"hillstrike\")"),
    "the remembered tier is a device preference, read on the client",
  );
  for (const difficulty of AI_DIFFICULTIES) {
    assert.equal(typeof difficulty, "string");
  }
});

/* -------------------------------------------------------------------------- *
 * Rendering
 * -------------------------------------------------------------------------- */

test("hillstrike practice: one canvas, drawn fluidly on every screen", () => {
  assert.ok(fieldCode.includes("<canvas"), "the battlefield is a canvas");
  assert.ok(fieldCode.includes("devicePixelRatio"), "the canvas scales for a retina display");
  assert.ok(fieldCode.includes("ResizeObserver"), "the canvas follows its column's size");
  assert.ok(
    /aspectRatio: `\$\{BATTLEFIELD_WIDTH\} \/ \$\{BATTLEFIELD_HEIGHT\}`/.test(fieldCode),
    "the battlefield keeps the engine's aspect ratio",
  );
  assert.ok(fieldCode.includes("applyCanvasSize"), "layout is measured, then scaled");
  assert.ok(
    fieldCode.includes('className="block h-full w-full"'),
    "the canvas fills its fluid wrapper",
  );
  // No fixed board size anywhere (that is what breaks phones).
  assert.equal(/\bwidth=\{\d{3,}\}/.test(fieldCode), false, "no fixed canvas width");
  assert.equal(/\bheight=\{\d{3,}\}/.test(fieldCode), false, "no fixed canvas height");
  // The page is a single column on phones and two on desktop.
  assert.ok(pageCode.includes("lg:grid-cols-[minmax(0,1fr)_320px]"));
  assert.ok(pageCode.includes("overflow-x-clip"));
});

test("hillstrike practice: the board draws both gunners, towers, terrain and impacts", () => {
  for (const symbol of [
    "field.terrain",
    "field.blocks",
    "field.players",
    "drawPlayer",
    "drawBlock",
    "drawPreview",
    "collapse",
    "impact",
  ]) {
    assert.ok(fieldCode.includes(symbol), `the battlefield must draw ${symbol}`);
  }
  assert.ok(fieldCode.includes("current.lives[seat]"), "the board shows each gunner's lives");
  // A direct hit is announced on the board, not just in the HUD.
  assert.ok(
    fieldCode.includes("-1") && fieldCode.includes("livesLost"),
    "a lost life is flagged where the shot landed",
  );
  // The animation is driven by the engine's recorded trajectory.
  assert.ok(fieldCode.includes("shot.path"));
  assert.ok(fieldCode.includes("shot.events"));
  assert.ok(fieldCode.includes("requestAnimationFrame"), "the flight is animated, not teleported");
});

test("hillstrike practice: the HUD shows turn, volley, lives and the result", () => {
  for (const testId of [
    "hillstrike-status",
    "hillstrike-seat-you",
    "hillstrike-seat-ai",
    "hillstrike-fire",
    "hillstrike-clear",
    "hillstrike-restart",
    "hillstrike-notice",
    "hillstrike-aim-readout",
    "hillstrike-session",
  ]) {
    assert.ok(hudCode.includes(testId), `the HUD needs a stable ${testId} hook`);
  }
  assert.ok(hudCode.includes('role="status"'), "the turn/status line is a live region");
  assert.ok(hudCode.includes("disabled={!aim || !canPlay}"), "Fire is disabled without a legal aim");
  assert.ok(
    pageCode.includes("<PvpResultScreen") && pageCode.includes("open={Boolean(matchOver)}"),
    "the shared result screen reports the match",
  );
  for (const testId of [
    "hillstrike-battlefield",
    "hillstrike-loading",
  ]) {
    assert.ok(pageCode.includes(testId) || fieldCode.includes(testId), `stable ${testId} hook`);
  }
  assert.equal(DEFAULT_MAX_PULL > 0, true);
  assert.equal(POWER_MAX, 100);
});

test("hillstrike practice: the browser harness keeps its handles", () => {
  // The qa harness reads the battlefield's data attributes instead of guessing
  // at canvas pixels; keep the contract it depends on.
  for (const attribute of [
    "data-turn",
    "data-status",
    "data-seed",
    "data-resolving",
    "data-blocks",
    "data-cracked",
    "data-terrain-signature",
    "data-lives-player1",
    "data-lives-player2",
    "data-shots-remaining",
    "data-winner",
    "data-aim-angle",
    "data-aim-power",
    "data-preview-impact",
    "data-preview-x",
    "data-preview-y",
    "data-last-impact",
    "data-last-lives-lost",
    "data-last-target",
    "data-interactive",
    "data-turn-index",
  ]) {
    assert.ok(fieldCode.includes(attribute), `the battlefield must expose ${attribute}`);
  }
});

/* -------------------------------------------------------------------------- *
 * Free, local practice
 * -------------------------------------------------------------------------- */

test("hillstrike practice: free play never wagers, rates or calls the server", () => {
  // Code-level only: the page legitimately SAYS "no wager" in its copy, which
  // is the opposite of taking one.
  for (const token of ["fetch(", "axios", "/api/", "supabase", "stake", "escrow", "coins"]) {
    assert.equal(
      pageCode.includes(token),
      false,
      `practice must stay local and free (found ${token})`,
    );
  }
  assert.ok(/Free practice/.test(page), "the page says practice is free");
  assert.ok(/no wager/i.test(page), "the page says there is no wager");
  assert.ok(
    /subline="Free practice/.test(page),
    "the result screen repeats that nothing was at stake",
  );
  // Client-side only: the whole match lives in React state.
  assert.ok(pageCode.includes('"use client"'));
  assert.ok(pageCode.includes("useState"));
});

test("hillstrike practice: the route is public and self-describing", () => {
  assert.ok(routeCode.includes("Metadata"), "the route exports metadata");
  assert.ok(/Hillstrike vs AI/.test(route), "the title names the practice board");
  assert.ok(routeCode.includes("PageClient"), "the route renders the client board");
  const patterns = proxy.slice(proxy.indexOf("GAME_ROUTE_PATTERNS"));
  assert.ok(
    patterns.includes('"/casino/hillstrike(.*)"'),
    "the game route patterns must include the Hillstrike practice board",
  );
});
