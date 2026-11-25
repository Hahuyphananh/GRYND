/**
 * ui-sounds.test.mjs
 *
 * Pins the interface-sound layer:
 *
 *   1. It reuses the existing shared, mute-aware AudioContext (no second volume
 *      store and no direct `new Audio()`), so SoundToggle silences it too.
 *   2. The levels stay quiet, and nothing is sampled or fetched.
 *   3. Sounds are event-driven only — no page-load, navigation or scroll audio.
 *   4. Hover is opt-in (`data-sound-hover`), mouse-only, and armed by a press.
 *   5. The nav exposes the persisted mute control on both layouts.
 *
 * Run: npm run test:ui-sounds
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const UI_SOUNDS = "src/lib/uiSounds.ts";
const LISTENER = "src/components/UiSounds.tsx";
const TOGGLE = "src/components/SoundToggle.jsx";
const SETTINGS = "src/lib/audioSettings.ts";
const CHROME = "src/components/SiteChrome.tsx";
const NAV = "src/components/navigation-bar.jsx";

test("UI sounds reuse the shared mute-aware context and stay quiet", () => {
  const code = stripComments(read(UI_SOUNDS));

  assert.match(code, /getSharedAudioContext/);
  assert.doesNotMatch(code, /new Audio\(|fetch\(|setInterval/);

  for (const name of ["CLICK_VOLUME", "TOGGLE_VOLUME", "HOVER_VOLUME"]) {
    const match = code.match(new RegExp(`${name} = ([0-9.]+)`));
    assert.ok(match, `${name} must be a named, tunable constant`);
    assert.ok(Number(match[1]) <= 0.03, `${name} must remain quiet`);
  }

  // Hover is the quietest and rate-limited so a sweep cannot chatter.
  assert.match(code, /now - lastHoverAt < 90/);
});

test("nothing plays on load, navigation or scroll", () => {
  const code = stripComments(read(LISTENER));

  assert.match(code, /useEffect\(/);
  assert.doesNotMatch(code, /addEventListener\("(scroll|wheel|load|DOMContentLoaded)"/);
  assert.match(code, /addEventListener\("pointerdown"/);
  assert.match(code, /addEventListener\("click"/);
  assert.match(code, /addEventListener\("pointerover"/);

  // Hover needs a prior press and a real mouse; touch never triggers it.
  assert.match(code, /let armed = false/);
  assert.match(code, /if \(!armed \|\| event\.pointerType !== "mouse"\) return;/);

  // Per-control opt-out and primary-CTA-only hover.
  assert.match(code, /data-sound="off"/);
  assert.match(code, /\[data-sound-hover\]/);
});

test("one listener layer is mounted, and the mute control in both nav layouts", () => {
  assert.equal((read(CHROME).match(/<UiSounds \/>/g) || []).length, 1);
  assert.equal((read(NAV).match(/<SoundToggle/g) || []).length, 2);
  assert.match(read(TOGGLE), /data-testid="sound-toggle"/);
  assert.match(read(TOGGLE), /showLabel/);
});

test("the mute choice is persisted and shared across tabs", () => {
  const settings = read(SETTINGS);
  assert.match(settings, /grynd_audio_muted/);
  assert.match(settings, /localStorage\.setItem/);
  assert.match(settings, /addEventListener\("storage"/);
  assert.match(read(TOGGLE), /subscribeAudioMuted/);
});

test("sound helpers are no-ops without a browser audio context", async () => {
  const { playUiClick, playUiHover, playUiToggle } = await import("../src/lib/uiSounds.ts");
  assert.doesNotThrow(() => {
    playUiClick();
    playUiHover(); // repeated on purpose: the rate limiter must not throw
    playUiHover();
    playUiToggle(true);
    playUiToggle(false);
  });
});
