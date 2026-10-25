/**
 * hillstrike-practice-ui.test.mjs
 *
 * The contracts the Hillstrike practice screen has to keep, pinned at the TEXT
 * level — the things a browser check cannot see cheaply:
 *
 *   • the UI owns no rule. Collisions, damage, HP, turns and the winner come
 *     from `src/lib/hillstrike/*`; a component only draws state and reports a
 *     gesture. A drag becomes an aim through the ENGINE's `aimFromDrag`, a
 *     preview is a real `simulateShot`, any of the three actions is `applyAction`.
 *   • the canvas is fluid (aspect-ratio + ResizeObserver + device-pixel-ratio
 *     scaling), never a fixed pixel board, so it fits a phone and a desktop.
 *   • the tanks are drawn as TANKS (tracks, hull, turret, barrel, HP bar), not
 *     as discs, and the board shows the HP the engine resolved.
 *   • practice stays free and local: no wager, no rating, no network call.
 *   • every affordance the design asks for (HP, turn, actions left, Fire, Drive,
 *     Build, Restart, result) has a stable hook, and the browser harness's
 *     handles stay put.
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
  ACTIONS_PER_TURN,
  DEFAULT_MAX_PULL,
  MAX_HP,
  MOVE_STEP,
  POWER_MAX,
} from "../src/lib/hillstrike/constants.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The same source with `//` and slash-star commentary removed. */
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
    "validateAction",
    "applyAction",
    "simulateShot",
    "chooseAiAction",
    "hpOf",
  ]) {
    assert.ok(pageCode.includes(symbol), `the page must use the engine's ${symbol}`);
  }

  // An action is accepted by the ENGINE, from the engine's own verdict — the
  // exact shape the server route uses.
  assert.ok(pageCode.includes("validateAction(current, seat, action)"));
  assert.ok(pageCode.includes("applyAction(current, seat, action)"));

  // The bot answers through the SAME call as the human: it is given no private
  // path into the rules, and its action can be a drive or a build too.
  assert.ok(
    /playAction\(AI_SEAT, action\)/.test(pageCode),
    "the bot's action must resolve through the same playAction as the player's",
  );
  assert.ok(
    /playAction\(HUMAN_SEAT, \{ type: "shoot", \.\.\.aim \}\)/.test(pageCode),
    "the player's Fire must resolve through playAction",
  );
  for (const kind of ["shoot", "move", "build"]) {
    assert.ok(
      pageCode.includes(`"${kind}"`),
      `the practice page must be able to take a ${kind} action`,
    );
  }
});

test("hillstrike practice: no component decides a collision, HP or a turn", () => {
  const forbidden = [
    // physics / rules that may only live in the engine
    "GRAVITY",
    "PROJECTILE_",
    "IMPACT_KINDS.PLAYER",
    "block-destroyed",
    "hp-depleted",
    "turnIndex =",
    "actionsRemaining =",
    "damage =",
    // no second rules implementation anywhere in the UI
    "simulateShot",
    "applyAction",
    "validateAction",
    "createInitialState",
    "createBattlefield",
  ];
  for (const [name, code] of [
    ["battlefield", fieldCode],
    ["hud", hudCode],
  ]) {
    for (const token of forbidden) {
      assert.equal(
        code.includes(token),
        false,
        `${name} must not contain engine logic (found ${token})`,
      );
    }
    // Reading HP for a bar is fine; WRITING it is a second rulebook.
    assert.equal(
      /hp\[[^\]]+\]\s*=[^=]/.test(code),
      false,
      `${name} must not write the engine's hp`,
    );
    assert.ok(
      code.includes("hpOf("),
      `${name} must read HP through the engine's own accessor`,
    );
  }

  // …and the page never mutates it either.
  for (const fieldName of ["hp", "turn", "actionsRemaining", "winner", "status", "lastAction"]) {
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
  assert.ok(fieldCode.includes("preview.path"));
  assert.ok(fieldCode.includes("preview.impact"));
});

/* -------------------------------------------------------------------------- *
 * Rules the UI must READ, never duplicate
 * -------------------------------------------------------------------------- */

test("hillstrike practice: HP, turns and action limits come from the constants", () => {
  assert.ok(
    hudCode.includes("MAX_HP"),
    "the HUD draws its HP bar against the engine's maximum",
  );
  assert.equal(/100\s*(hp|HP)/.test(hudCode), false, "no hard-coded HP total");
  assert.ok(
    hudCode.includes("MOVE_RANGE"),
    "the drive copy is written from the engine's leash, never a hard-coded one",
  );
  assert.ok(
    hudCode.includes("buffsOf(state, viewerSeat)"),
    "the HUD shows the buffs the engine says are active",
  );
  assert.equal(
    /ACTIONS_PER_TURN|actionsRemaining\s*[-+*/]/.test(pageCode),
    false,
    "the page must never compute the turn counter itself",
  );
  // The values the HUD shows are the state's own.
  for (const read of ["hpOf(state, seat)", "state.actionsRemaining", "state.turn === seat"]) {
    assert.ok(hudCode.includes(read), `the HUD must render ${read}`);
  }
  assert.ok(pageCode.includes("TICK_MS"), "the flight time is derived from the engine's tick");
  assert.equal(MAX_HP, 100);
  assert.equal(ACTIONS_PER_TURN, 2);
  assert.ok(MOVE_STEP > 0);
});

test("hillstrike practice: the difficulty changes only the bot's plan", () => {
  assert.ok(pageCode.includes('from "../../../../lib/hillstrike/ai"'));
  assert.ok(pageCode.includes("chooseAiAction({"));
  assert.ok(pageCode.includes("difficulty,"), "the tier is handed to the bot's planner");
  assert.ok(pageCode.includes("HILLSTRIKE_TIER_HINTS"), "each tier explains itself");
  assert.ok(pageCode.includes('gameKey="hillstrike"'), "the shared picker is scoped per game");
  assert.ok(
    pageCode.includes('readStoredAiDifficulty("hillstrike")'),
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
    fieldCode.includes("aspectRatio: `${BATTLEFIELD_WIDTH} / ${BATTLEFIELD_HEIGHT}`"),
    "the battlefield keeps the engine's aspect ratio",
  );
  assert.ok(fieldCode.includes("applyCanvasSize"), "layout is measured, then scaled");
  assert.ok(
    fieldCode.includes('className="block h-full w-full"'),
    "the canvas fills its fluid wrapper",
  );
  // The middle's respawn timer is drawn from the engine's own schedule, so a
  // collected pickup reads as "coming back" instead of vanishing.
  assert.ok(
    fieldCode.includes("respawnsOf(state.battlefield)"),
    "the board reads the engine's respawn tickets",
  );
  assert.ok(
    fieldCode.includes("ticket.atTurn") && fieldCode.includes("drawRespawnRing"),
    "and renders the countdown for each waiting pickup",
  );
  // No fixed board size anywhere (that is what breaks phones).
  assert.equal(/\bwidth=\{\d{3,}\}/.test(fieldCode), false, "no fixed canvas width");
  assert.equal(/\bheight=\{\d{3,}\}/.test(fieldCode), false, "no fixed canvas height");
  // The page is a single column on phones and two on desktop.
  assert.ok(pageCode.includes("lg:grid-cols-[minmax(0,1fr)_320px]"));
  assert.ok(pageCode.includes("overflow-x-clip"));
});

test("hillstrike practice: the board draws terrain, towers, tanks, HP and impacts", () => {
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

  // ── The tanks are actually tanks ─────────────────────────────────────
  // Tracks + road wheels + hull + turret + barrel: five distinct parts, so the
  // silhouette reads as an armoured vehicle and not as a coloured circle.
  for (const part of [
    "trackWidth",
    "trackTop",
    "wheelRadius",
    "hullWidth",
    "hullTop",
    "turretWidth",
    "turretTop",
    "roundedRect(",
  ]) {
    assert.ok(fieldCode.includes(part), `the tank must be drawn with a ${part}`);
  }
  assert.ok(
    fieldCode.includes("directionVector(aim.angleDeg)"),
    "the barrel follows the aim, so a tank reads as aiming",
  );
  assert.equal(
    /ctx\.arc\(x, y - 4, PLAYER_RADIUS/.test(fieldCode),
    false,
    "the old circle body is gone",
  );

  // ── HP on the board ──────────────────────────────────────────────────
  assert.ok(fieldCode.includes("hpOf(current, seat)"), "the board shows each tank's HP");
  assert.ok(
    fieldCode.includes("barWidth") && fieldCode.includes("barHeight"),
    "the board draws an HP bar",
  );
  assert.ok(fieldCode.includes("strokeText"), "the HP number is legible on any sky");
  assert.ok(
    fieldCode.includes("currentAnimation.action.damage"),
    "a hit is announced on the board with the damage the engine resolved",
  );

  // The animation is driven by the engine's recorded action.
  assert.ok(fieldCode.includes("action.path"), "the flight uses the recorded path");
  assert.ok(fieldCode.includes("action.events"), "the settle uses the recorded events");
  assert.ok(fieldCode.includes("requestAnimationFrame"), "the flight is animated, not teleported");
  // A drive rolls the tank, a build drops the block: both are animated.
  assert.ok(fieldCode.includes('action.type === "move"'), "a drive is animated");
  assert.ok(fieldCode.includes('action.type === "build"'), "a build is animated");
});

test("hillstrike practice: the HUD shows turn, actions, HP and the three actions", () => {
  for (const testId of [
    "hillstrike-status",
    "hillstrike-seat-you",
    "hillstrike-seat-ai",
    "hillstrike-fire",
    "hillstrike-clear",
    "hillstrike-move-forward",
    "hillstrike-move-back",
    "hillstrike-build",
    "hillstrike-restart",
    "hillstrike-notice",
    "hillstrike-aim-readout",
    "hillstrike-session",
  ]) {
    assert.ok(hudCode.includes(testId), `the HUD needs a stable ${testId} hook`);
  }
  assert.ok(hudCode.includes('role="status"'), "the turn/status line is a live region");
  assert.ok(hudCode.includes('role="meter"'), "the HP bar is a real meter");
  assert.ok(hudCode.includes("disabled={!aim || !canPlay}"), "Fire is disabled without a legal aim");
  // Drive and Build are wired to the page's handlers, never to a rule of their own.
  assert.ok(
    hudCode.includes("onMove(") && hudCode.includes("onBuild"),
    "the Drive and Build buttons call the page's handlers",
  );
  assert.ok(pageCode.includes("onMove={drive}") && pageCode.includes("onBuild={build}"));
  assert.ok(
    pageCode.includes("<PvpResultScreen") && pageCode.includes("open={Boolean(matchOver)}"),
    "the shared result screen reports the match",
  );
  for (const testId of ["hillstrike-battlefield", "hillstrike-loading"]) {
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
    "data-hp-player1",
    "data-hp-player2",
    "data-actions-remaining",
    "data-winner",
    "data-aim-angle",
    "data-aim-power",
    "data-preview-impact",
    "data-preview-x",
    "data-preview-y",
    "data-last-impact",
    "data-last-damage",
    "data-last-target",
    "data-last-action",
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
