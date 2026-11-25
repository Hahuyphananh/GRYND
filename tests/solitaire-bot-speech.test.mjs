/**
 * solitaire-bot-speech.test.mjs
 *
 * Phase 3: the opponent speech bubble.
 *
 * The bubble is a renderer, so these tests pin BOTH sides of the contract:
 *
 *   1. RENDERING — every one of the six bots renders its real roster avatar and
 *      resolves its Phase 1 key through `t()`. A silent bot shows the fallback;
 *      a new line replaces the old one.
 *   2. ACCESSIBILITY & SAFETY — one polite live region, pointer-events-none,
 *      no controls, no focus moves, a fixed-height two-line slot.
 *   3. INTEGRATION — the match page builds its snapshot only for `isAi`, passes
 *      it through the Phase 2 hook, and renders no mascot system in the bubble.
 *
 * Module mocking is required for the translation hook, so run with
 * `--experimental-test-module-mocks` (the npm script does).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import React from "react";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:solitaire-bot-speech";

// A tiny stand-in for useTranslation: returns the key itself, so the test can
// prove the component asks for the Phase 1 key rather than a hardcoded string.
if (MODULE_MOCKING_AVAILABLE) {
  mock.module("../src/hooks/useTranslation.js", {
    namedExports: {
      useTranslation: () => ({ t: (key) => key, language: "en" }),
    },
  });
}

const { default: BotSpeech } = await import(
  "../src/components/solitaire-duel/BotSpeech.tsx"
);
const { renderToStaticMarkup } = await import("react-dom/server");
const { SOLITAIRE_BOTS } = await import("../src/lib/solitaire-duel/bots.ts");
const { solitaireBotDialogueKey } = await import(
  "../src/lib/solitaire-duel/dialogueLines.ts"
);

const read = (rel) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const render = (props) =>
  renderToStaticMarkup(React.createElement(BotSpeech, props));

const lineFor = (botId, event = "win") => ({
  botId,
  key: solitaireBotDialogueKey(botId, event, 0),
  event,
  id: `match:${event}:1`,
  durationMs: 5_000,
});

const PAGE = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const COMPONENT = "src/components/solitaire-duel/BotSpeech.tsx";

// ── Rendering for all six bots ───────────────────────────────────────────

test("renders the real avatar and key for every one of the six bots", () => {
  assert.equal(SOLITAIRE_BOTS.length, 6);
  for (const bot of SOLITAIRE_BOTS) {
    const markup = render({ bot, line: lineFor(bot.id) });
    assert.ok(
      markup.includes(bot.avatar.src),
      `${bot.id} is missing its avatar src`,
    );
    assert.ok(
      markup.includes(bot.avatar.alt.replace(/"/g, "&quot;")),
      `${bot.id} is missing its avatar alt`,
    );
    assert.ok(
      markup.includes(lineFor(bot.id).key),
      `${bot.id} did not resolve its dialogue key`,
    );
    assert.ok(markup.includes(`data-bot-id="${bot.id}"`));
  }
});

test("Glitch keeps the perfect id and roster avatar, not a mascot component", () => {
  const glitch = SOLITAIRE_BOTS.find((bot) => bot.id === "perfect");
  assert.ok(glitch);
  const markup = render({ bot: glitch, line: lineFor("perfect") });
  assert.ok(markup.includes('data-bot-id="perfect"'));
  assert.ok(markup.includes("/images/mascot/glitch-idle.webp"));
  assert.ok(markup.includes('data-line-event="win"'));
});

test("a silent bot shows the fallback, and a line replaces it", () => {
  const rookie = SOLITAIRE_BOTS[0];
  const fallback = "Just getting started. A relaxed opponent.";

  const silent = render({ bot: rookie, line: null, fallback });
  assert.ok(silent.includes(fallback));
  assert.match(silent, /data-line-event="none"/);
  assert.ok(!silent.includes("solitaireBots.rookie."));

  const speaking = render({ bot: rookie, line: lineFor("rookie", "foundation") });
  assert.ok(speaking.includes(lineFor("rookie", "foundation").key));
  assert.ok(!speaking.includes(fallback));
  assert.match(speaking, /data-line-event="foundation"/);
});

test("a new line replaces the old one (dismissal is controlled by the hook)", () => {
  const felix = SOLITAIRE_BOTS.find((bot) => bot.id === "felix");
  const first = render({ bot: felix, line: lineFor("felix", "foundation") });
  const second = render({ bot: felix, line: lineFor("felix", "win") });
  assert.ok(first.includes(lineFor("felix", "foundation").key));
  assert.ok(!first.includes(lineFor("felix", "win").key));
  assert.ok(second.includes(lineFor("felix", "win").key));
  assert.ok(!second.includes(lineFor("felix", "foundation").key));
});

test("the optional avatar can be omitted when the surface already has one", () => {
  const ace = SOLITAIRE_BOTS.find((bot) => bot.id === "ace");
  const markup = render({
    bot: ace,
    line: lineFor("ace"),
    showAvatar: false,
  });
  assert.ok(!markup.includes(ace.avatar.src));
  assert.ok(markup.includes(lineFor("ace").key));
});

// ── Accessibility and non-interference ──────────────────────────────────

test("uses exactly one polite, atomic live region", () => {
  const markup = render({ bot: SOLITAIRE_BOTS[0], line: lineFor("rookie") });
  assert.equal((markup.match(/role="status"/g) ?? []).length, 1);
  assert.equal((markup.match(/aria-live="polite"/g) ?? []).length, 1);
  assert.equal((markup.match(/aria-atomic="true"/g) ?? []).length, 1);
});

test("cannot capture pointer events, focus or controls", () => {
  const markup = render({ bot: SOLITAIRE_BOTS[0], line: lineFor("rookie") });
  assert.match(markup, /pointer-events-none/);
  assert.doesNotMatch(markup, /<button|<a\s|<input|<textarea/i);
  assert.doesNotMatch(markup, /tabindex=/i);
  assert.doesNotMatch(markup, /autofocus/i);
  assert.doesNotMatch(markup, /onclick=/i);

  const source = read(COMPONENT);
  assert.doesNotMatch(source, /onClick=|tabIndex=|autoFocus/);
  assert.doesNotMatch(source, /from\s+["'][^"']*mascot/);
  assert.doesNotMatch(source, /\buseGlitch\s*\(/);
});

// ── Mobile layout ───────────────────────────────────────────────────────

test("reserves a fixed two-line slot instead of growing the page", () => {
  const source = read(COMPONENT);
  assert.match(source, /h-9/); // fixed 36px slot
  assert.match(source, /line-clamp-2/);
  assert.doesNotMatch(source, /className="[^"]*\b(fixed|absolute)\b/);
  assert.doesNotMatch(source, /min-h-screen|py-10|mt-10/);
});

// ── Page integration ────────────────────────────────────────────────────

test("the match page builds a snapshot only for a practice bot", () => {
  const page = read(PAGE);
  assert.match(page, /useSolitaireBotDialogue\(dialogueSnapshot, \{ paused \}\)/);
  assert.match(page, /isPractice && practiceBot && practiceBotId && match/);
  assert.match(page, /botId: practiceBotId/);
  assert.match(page, /const practiceBotId =\s*practiceBot && isSolitaireBotId\(practiceBot\.id\)/);
});

test("the bubble lives in the existing opponent strip, not a new section", () => {
  const page = read(PAGE);
  assert.match(page, /data-testid="solitaire-bot-opponent"/);
  assert.match(page, /<BotSpeech[\s\S]{0,400}fallback=\{practiceBot\.description\}/);
  assert.match(page, /showAvatar=\{false\}/);
  // The old raw description paragraph is gone; the strip keeps its padding.
  assert.doesNotMatch(page, /truncate text-\[11px\] text-white\/45/);
});

test("only practice results hand the opponent the last word", () => {
  const page = read(PAGE);
  assert.match(page, /showGlitch=\{!isPractice\}/);
  assert.match(
    page,
    /botLine\.event === "win" \|\| botLine\.event === "loss"/,
  );
  assert.match(page, /testId="solitaire-bot-result-speech"/);
});

test("the page never reintroduces the floating mascot for opponent lines", () => {
  const page = read(PAGE);
  assert.doesNotMatch(page, /useGlitch\(/);
  assert.doesNotMatch(page, /<GlitchSay/);
});

if (SKIP_REASON) {
  test.skip(SKIP_REASON, () => {});
}
