/**
 * speed-typing-device-match.test.mjs
 *
 * FAIR PAIRING BY INPUT DEVICE — the detection and the pool decision.
 *
 * A phone has no physical keyboard, so a phone-vs-computer typing race measures
 * hardware instead of typing skill, which is the one thing this game exists to
 * measure. Two things make the fix work, and this file tests both:
 *
 *   1. DETECTION — which pool a request belongs to, decided from the request's
 *      OWN HEADERS (`Sec-CH-UA-Mobile`, then `Sec-CH-UA-Platform`, then the
 *      User-Agent). Never from anything a caller sends: the game's contract is
 *      that a player may only ever say WHAT THEY TYPED, and a self-declared
 *      device class is exactly the kind of claim the rest of this game refuses
 *      (see tests/speed-typing-e2e.test.mjs and -platform.test.mjs, which both
 *      assert the route reads no payload at all).
 *
 *   2. THE POOL DECISION — `pickLobbyFor` is pure, so the whole matchmaking
 *      choice is exercised here without a database: same pool first, a
 *      class-neutral lobby next, the other pool only once the waiting lobby has
 *      waited past DEVICE_MATCH_WIDEN_MS, and otherwise null (open a new lobby
 *      rather than drop the caller into an unfair race). An unclassifiable
 *      caller keeps the pre-0209 behaviour exactly, which is what the platform
 *      quick-queue's two calls need.
 *
 * The store's use of this decision is driven for real in
 * tests/speed-typing-store.test.mjs (`device:` scenarios), and the columns
 * themselves are pinned in tests/speed-typing-schema.test.mjs.
 *
 * Run:  node --import tsx --test tests/speed-typing-device-match.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_CLASS,
  DEVICE_MATCH_WIDEN_MS,
  UNKNOWN_DEVICE_CLASS,
} from "../src/lib/speed-typing/constants.ts";
import {
  coerceDeviceClass,
  deviceClassColumnValue,
  deviceClassFromHeaders,
  pickLobbyFor,
} from "../src/lib/speed-typing/deviceClass.ts";

/** A Headers-like reader over a plain object (header names lowercased). */
const headers = (map) => ({
  get: (name) => map[name.toLowerCase()] ?? null,
});

const NOW = 1_700_000_000_000;
/**
 * An open lobby, oldest-first when built in order.
 *
 * `in` rather than `??`, so an explicit `null` device class (a class-neutral
 * lobby) and an explicit `null` date are expressible rather than replaced by
 * the defaults.
 */
const lobby = (over = {}) => ({
  id: over.id ?? "lobby-1",
  player1Id: over.player1Id ?? "user_host",
  player1DeviceClass:
    "player1DeviceClass" in over ? over.player1DeviceClass : DEVICE_CLASS.KEYBOARD,
  createdAt: "createdAt" in over ? over.createdAt : new Date(NOW - 30_000),
});

// ════════════════════════════════════════════════════════════════════════
// 1. Detection: the request's own headers, in order of trustworthiness
// ════════════════════════════════════════════════════════════════════════

test("device: the browser's own mobile hint is decisive", () => {
  // Chromium answers ?1 for a phone/tablet and ?0 for a computer. It is what
  // the browser thinks the device IS, so nothing below it may override it.
  assert.equal(
    deviceClassFromHeaders(
      headers({ "sec-ch-ua-mobile": "?1", "user-agent": "Mozilla/5.0 (Windows NT 10.0)" }),
    ),
    DEVICE_CLASS.TOUCH,
    "?1 wins even over a desktop-looking UA",
  );
  assert.equal(
    deviceClassFromHeaders(
      headers({ "sec-ch-ua-mobile": "?0", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" }),
    ),
    DEVICE_CLASS.KEYBOARD,
    "?0 wins even over a phone-looking UA",
  );
});

test("device: the platform hint decides when the mobile hint is stripped", () => {
  assert.equal(
    deviceClassFromHeaders(headers({ "sec-ch-ua-platform": '"Android"' })),
    DEVICE_CLASS.TOUCH,
  );
  assert.equal(
    deviceClassFromHeaders(headers({ "sec-ch-ua-platform": '"iOS"' })),
    DEVICE_CLASS.TOUCH,
  );
  assert.equal(
    deviceClassFromHeaders(headers({ "sec-ch-ua-platform": '"Windows"' })),
    DEVICE_CLASS.KEYBOARD,
  );
  assert.equal(
    deviceClassFromHeaders(headers({ "sec-ch-ua-platform": '"macOS"' })),
    DEVICE_CLASS.KEYBOARD,
  );
  // A Chromebook is a computer with a keyboard; the rare Chrome OS tablet
  // answers ?1 above, which is why the platform alone may say `keyboard`.
  assert.equal(
    deviceClassFromHeaders(headers({ "sec-ch-ua-platform": '"Chrome OS"' })),
    DEVICE_CLASS.KEYBOARD,
  );
  // An unknown platform name falls through to the UA, not to a guess.
  assert.equal(
    deviceClassFromHeaders(headers({ "sec-ch-ua-platform": '"Fuchsia"' })),
    UNKNOWN_DEVICE_CLASS,
  );
});

test("device: the User-Agent is the fallback, and phones are recognised before computers", () => {
  const ua = (value) => deviceClassFromHeaders(headers({ "user-agent": value }));

  // Phones and tablets — including the ones that report a desktop layout.
  for (const value of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
    "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari/537.36 Tablet",
    "Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1) IEMobile/11.0",
  ]) {
    assert.equal(ua(value), DEVICE_CLASS.TOUCH, value);
  }

  // Computers. A mobile UA also contains "Mozilla"/"Safari", which is exactly
  // why the touch patterns are matched first.
  for (const value of [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120.0",
  ]) {
    assert.equal(ua(value), DEVICE_CLASS.KEYBOARD, value);
  }

  // No usable UA at all — a bot, a bare HTTP call, a header-stripping proxy.
  assert.equal(deviceClassFromHeaders(headers({})), UNKNOWN_DEVICE_CLASS);
  assert.equal(deviceClassFromHeaders(headers({ "user-agent": "" })), UNKNOWN_DEVICE_CLASS);
  assert.equal(deviceClassFromHeaders(headers({ "user-agent": "curl/8.4.0" })), UNKNOWN_DEVICE_CLASS);
  assert.equal(deviceClassFromHeaders(null), UNKNOWN_DEVICE_CLASS, "no headers is unknown, not an error");
});

// ════════════════════════════════════════════════════════════════════════
// 2. The stored vocabulary
// ════════════════════════════════════════════════════════════════════════

test("device: only the two pool names are real; everything else is unknown", () => {
  assert.equal(coerceDeviceClass(DEVICE_CLASS.KEYBOARD), DEVICE_CLASS.KEYBOARD);
  assert.equal(coerceDeviceClass(DEVICE_CLASS.TOUCH), DEVICE_CLASS.TOUCH);
  for (const value of [null, undefined, "", "desktop", "phone", "TOUCH", 1, {}, []]) {
    assert.equal(coerceDeviceClass(value), UNKNOWN_DEVICE_CLASS, String(value));
  }
});

test("device: the column stores NULL for unknown, never a third vocabulary value", () => {
  // Migration 0209's CHECK admits only 'keyboard' | 'touch' | NULL, so an
  // unclassifiable seat is ABSENT from the vocabulary rather than a third value
  // in it — which is what keeps every lobby joinable.
  assert.equal(deviceClassColumnValue(DEVICE_CLASS.KEYBOARD), "keyboard");
  assert.equal(deviceClassColumnValue(DEVICE_CLASS.TOUCH), "touch");
  assert.equal(deviceClassColumnValue(UNKNOWN_DEVICE_CLASS), null);
  assert.equal(deviceClassColumnValue("phone"), null);
  assert.equal(deviceClassColumnValue(undefined), null);
});

// ════════════════════════════════════════════════════════════════════════
// 3. The pool decision
// ════════════════════════════════════════════════════════════════════════

test("device: no open lobbies means open one", () => {
  assert.equal(pickLobbyFor({ candidates: [], deviceClass: DEVICE_CLASS.KEYBOARD, nowMs: NOW }), null);
});

test("device: a classed caller takes the oldest lobby in their OWN pool", () => {
  const oldTouch = lobby({
    id: "touch-old",
    player1DeviceClass: DEVICE_CLASS.TOUCH,
    createdAt: new Date(NOW - 60_000),
  });
  const newKeyboard = lobby({
    id: "keyboard-new",
    player1DeviceClass: DEVICE_CLASS.KEYBOARD,
    createdAt: new Date(NOW - 1_000),
  });

  // The keyboard lobby is NEWER, and it is still the one chosen: pairing within
  // the pool outranks first-come-first-served, and the wait rule does not apply
  // to a same-pool lobby.
  assert.equal(
    pickLobbyFor({
      candidates: [oldTouch, newKeyboard],
      deviceClass: DEVICE_CLASS.KEYBOARD,
      nowMs: NOW,
    })?.id,
    "keyboard-new",
  );
  assert.equal(
    pickLobbyFor({
      candidates: [oldTouch, newKeyboard],
      deviceClass: DEVICE_CLASS.TOUCH,
      nowMs: NOW,
    })?.id,
    "touch-old",
  );
});

test("device: a class-neutral lobby pairs with anyone, immediately", () => {
  // A lobby with no device class — a legacy row, or the platform quick-queue's
  // placeholder — is not a pool of its own: it accepts the next caller whatever
  // input they are on, with no waiting period. That is what stops this feature
  // from stranding a client that cannot be classified.
  const neutral = lobby({ id: "neutral", player1DeviceClass: null, createdAt: new Date(NOW) });
  for (const deviceClass of [DEVICE_CLASS.KEYBOARD, DEVICE_CLASS.TOUCH]) {
    assert.equal(
      pickLobbyFor({ candidates: [neutral], deviceClass, nowMs: NOW })?.id,
      "neutral",
      deviceClass,
    );
  }
});

test("device: the other pool is not joined until the lobby has waited", () => {
  const fresh = lobby({
    id: "fresh-keyboard",
    player1DeviceClass: DEVICE_CLASS.KEYBOARD,
    createdAt: new Date(NOW - 1_000),
  });

  // Inside the window: no lobby is returned, so the caller opens their own in
  // their own pool rather than being dropped into an unfair race on arrival.
  assert.equal(
    pickLobbyFor({ candidates: [fresh], deviceClass: DEVICE_CLASS.TOUCH, nowMs: NOW }),
    null,
  );

  // At the boundary the wait has been served — and the boundary is inclusive,
  // so the behaviour is exactly reproducible from the documented constant.
  assert.equal(
    pickLobbyFor({
      candidates: [fresh],
      deviceClass: DEVICE_CLASS.TOUCH,
      nowMs: fresh.createdAt.getTime() + DEVICE_MATCH_WIDEN_MS,
    })?.id,
    "fresh-keyboard",
  );
  assert.equal(
    pickLobbyFor({
      candidates: [fresh],
      deviceClass: DEVICE_CLASS.TOUCH,
      nowMs: fresh.createdAt.getTime() + DEVICE_MATCH_WIDEN_MS + 1,
    })?.id,
    "fresh-keyboard",
  );
});

test("device: the widening window is measured on the WAITING lobby, not the arrival", () => {
  // The keyboard lobby has been open 30s: a phone that arrives now is paired
  // with it, however fresh that phone's own arrival is.
  const waited = lobby({
    id: "waited",
    player1DeviceClass: DEVICE_CLASS.KEYBOARD,
    createdAt: new Date(NOW - 30_000),
  });
  assert.equal(
    pickLobbyFor({ candidates: [waited], deviceClass: DEVICE_CLASS.TOUCH, nowMs: NOW })?.id,
    "waited",
  );
});

test("device: an unclassifiable caller keeps the pre-0209 behaviour exactly", () => {
  // This is the quick-queue path: the platform worker calls `createOrJoin` once
  // per seat with no device signal at all, and its two calls must still land on
  // ONE lobby. So an unknown caller takes the oldest open lobby whatever pool
  // it is in — no widening wait, no preference.
  const oldest = lobby({
    id: "oldest",
    player1DeviceClass: DEVICE_CLASS.TOUCH,
    createdAt: new Date(NOW - 30_000),
  });
  const newer = lobby({
    id: "newer",
    player1DeviceClass: DEVICE_CLASS.KEYBOARD,
    createdAt: new Date(NOW - 1_000),
  });
  assert.equal(pickLobbyFor({ candidates: [oldest, newer], deviceClass: undefined, nowMs: NOW })?.id, "oldest");
  assert.equal(
    pickLobbyFor({ candidates: [oldest, newer], deviceClass: "phone", nowMs: NOW })?.id,
    "oldest",
  );
});

test("device: a lobby with no creation date can never prove it has waited", () => {
  // Both are keyboard lobbies and the caller is a phone, so neither is a
  // same-pool or neutral candidate and only the widening rule is left. The
  // undated lobby sits FIRST in the queue and still loses: an unknown age is
  // never treated as an infinite wait.
  const undated = lobby({ id: "undated", createdAt: null });
  const waited = lobby({ id: "waited", createdAt: new Date(NOW - 30_000) });
  assert.equal(
    pickLobbyFor({ candidates: [undated, waited], deviceClass: DEVICE_CLASS.TOUCH, nowMs: NOW })?.id,
    "waited",
  );
});
