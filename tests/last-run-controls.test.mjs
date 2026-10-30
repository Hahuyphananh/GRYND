// tests/last-run-controls.test.mjs
//
// Controls and polish are easy to break silently: a key stops being swallowed,
// a blur stops releasing, the page starts scrolling on Space, or an effect
// crops up in the simulation. These tests pin the pure mapping, then assert the
// contracts the DOM-facing files are allowed to rely on.
//
// They also re-assert the physics constants, so a "polish" pass can never tune
// gameplay by accident.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  NEUTRAL_INPUT,
  controlForKey,
  isEditableTarget,
  releasedState,
  setHeld,
} from "../src/components/last-run/inputKeys.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const HOOK = "src/components/last-run/useRunInput.ts";
const ARENA = "src/components/last-run/RunnerArena.tsx";
const MATCH = "src/app/games/last-run/[matchId]/MatchClient.tsx";
const AUDIO = "src/components/last-run/useRunAudio.ts";
const ENGINE_CONSTANTS = "src/lib/last-run/constants.ts";

// ── Key mapping ─────────────────────────────────────────────────────────

test("keys: Space and ArrowUp jump, ArrowDown ducks, everything else is ignored", () => {
  assert.equal(controlForKey("Space"), "jump");
  assert.equal(controlForKey("ArrowUp"), "jump");
  assert.equal(controlForKey("ArrowDown"), "duck");
  assert.equal(controlForKey("ArrowLeft"), null);
  assert.equal(controlForKey("KeyW"), null);
  assert.equal(controlForKey("Enter"), null);
});

test("keys: text fields keep their own Space and arrows", () => {
  assert.equal(isEditableTarget("INPUT", false), true);
  assert.equal(isEditableTarget("TEXTAREA", false), true);
  assert.equal(isEditableTarget("SELECT", false), true);
  assert.equal(isEditableTarget("DIV", true), true, "contenteditable counts");
  assert.equal(isEditableTarget("BUTTON", false), false);
  assert.equal(isEditableTarget("BODY", false), false);
});

test("held state: duplicate edges are no-ops, real edges produce a new state", () => {
  const first = setHeld(NEUTRAL_INPUT, "jump", true);
  assert.equal(first.changed, true);
  assert.deepEqual(first.state, { jump: true, duck: false });

  const duplicate = setHeld(first.state, "jump", true);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.state, first.state, "no new object ⇒ no new network request");

  const second = setHeld(first.state, "duck", true);
  assert.equal(second.changed, true);
  assert.deepEqual(second.state, { jump: true, duck: true });

  const released = setHeld(second.state, "jump", false);
  assert.deepEqual(released.state, { jump: false, duck: true });
});

test("release: everything is released together, and the result is a fresh object", () => {
  const released = releasedState();
  assert.deepEqual(released, { jump: false, duck: false });
  assert.notEqual(released, NEUTRAL_INPUT, "never hand out the frozen constant to mutate");
});

// ── Input hook contracts ────────────────────────────────────────────────

test("hook: releases on blur, tab hide and pagehide; cancels pointer capture", () => {
  const source = read(HOOK);
  for (const marker of [
    'window.addEventListener("blur"',
    'document.addEventListener("visibilitychange"',
    'window.addEventListener("pagehide"',
    "onPointerCancel",
    "onLostPointerCapture",
    "setPointerCapture",
    "touchAction: \"none\"",
    "event.preventDefault()",
  ]) {
    assert.ok(source.includes(marker), `missing control guarantee: ${marker}`);
  }
  // Space must not scroll: the keydown path preventDefaults before acting.
  assert.ok(source.includes("if (event.repeat) return;"), "held keys must not re-emit");
  assert.ok(source.includes("isEditableTarget("), "text fields must keep their keys");
});

// ── Audio ───────────────────────────────────────────────────────────────

test("audio: muted by default, no autoplay, user gesture starts the context", () => {
  const source = read(AUDIO);
  assert.ok(source.includes("useState(false)"), "sound starts disabled");
  assert.ok(source.includes("localStorage"), "the choice is remembered locally");
  assert.ok(source.includes("AudioContext"), "synthesised, no remote assets");
  assert.ok(source.includes("resume()"), "a suspended context is resumed on demand");
  // No mount-time playback: sound only starts inside the explicit toggle.
  assert.ok(
    !/useEffect\(\(\)\s*=>\s*\{[\s\S]{0,400}?play\(/.test(source),
    "nothing may play from a mount effect",
  );
  const match = read(MATCH);
  assert.ok(match.includes("audio.toggle"), "a visible mute control exists");
  assert.ok(match.includes("aria-pressed={audio.enabled}"), "the mute control is announced");
});

// ── Visual polish, safely separated from the sim ────────────────────────

test("arena: poses, silhouettes, reduced motion and responsive caps are present", () => {
  const source = read(ARENA);
  for (const marker of [
    "RunnerFigure",
    "ducking",
    "jumping",
    "ObstacleShape",
    "kind === \"beam\"",
    "reducedMotion",
    "animate attributeName",
    "landscape:max-h",
    "touchAction: \"pan-y\"",
    "contrast-more:border",
  ]) {
    assert.ok(source.includes(marker), `arena is missing: ${marker}`);
  }
});

test("match page: guide before the match, touch pads with pressed state, reduced motion", () => {
  const source = read(MATCH);
  for (const marker of [
    "Controls",
    "Jump crates",
    "Duck under the beam",
    'controls.controlProps("jump")',
    'controls.controlProps("duck")',
    "controls.held.jump",
    "useReducedMotion",
    "motion.div",
    "Reconnecting",
  ]) {
    assert.ok(source.includes(marker), `match page is missing: ${marker}`);
  }
});

// ── Gameplay is untouched ───────────────────────────────────────────────

test("physics and protocol were not changed by the polish pass", () => {
  const constants = read(ENGINE_CONSTANTS);
  assert.match(constants, /export const GRAVITY = 3400;/);
  assert.match(constants, /export const JUMP_VELOCITY = 980;/);
  assert.match(constants, /export const RUNNER_STANDING_HEIGHT = 44;/);
  assert.match(constants, /export const RUNNER_DUCK_HEIGHT = 26;/);
  assert.match(constants, /export const TICK_HZ = 60;/);

  // The client still sends only two booleans on transition. Every `distance:``
  // in this file is a READ of the snapshot into the arena props, never part of
  // a request body.
  const match = read(MATCH);
  assert.ok(match.includes("body: JSON.stringify(input)"), "input stays { jump, duck }");
  // No field named `winner` anywhere in the client payload or props.
  assert.ok(!/\bwinner\s*:/.test(match), "the client never reports a winner");
  const requestBodies = [...match.matchAll(/body:\s*([^,\n]+)/g)].map((hit) => hit[1].trim());
  assert.deepEqual(requestBodies, ["JSON.stringify(input)"], "the only request body is the input state");
});
