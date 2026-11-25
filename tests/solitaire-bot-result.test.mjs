/**
 * solitaire-bot-result.test.mjs
 *
 * THE PRACTICE RESULT'S OPPONENT — a bot, not a handle.
 *
 * In a vs-bots match the player raced one of the six roster characters, so its
 * win/loss popup shows that character: the roster portrait beside its plain
 * name (never `@name`, which is an account handle), and the bot's OWN ending
 * line. Glitch keeps the ranked result; a practice result always has the bot
 * speaking, even when the last dialogue line the page saw was an ordinary one.
 *
 * Run: node --import tsx --test tests/solitaire-bot-result.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SOLITAIRE_BOTS } from "../src/lib/solitaire-duel/bots.ts";
import {
  DIALOGUE_DIRECTOR_DEFAULTS,
  solitaireResultLine,
} from "../src/lib/solitaire-duel/dialogueDirector.ts";
import { SOLITAIRE_BOT_DIALOGUE } from "../src/lib/solitaire-duel/dialogueLines.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const RESULT_SCREEN = "src/components/result/PvpResultScreen.jsx";
const PAGE = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const LOBBY = "src/app/casino/solitaire-duel/play-ai/PageClient.tsx";

// ── The ending line ────────────────────────────────────────────────────────

test("every bot resolves its own ending line for a settled practice result", () => {
  assert.equal(SOLITAIRE_BOTS.length, 6);

  for (const bot of SOLITAIRE_BOTS) {
    const won = solitaireResultLine({
      botId: bot.id,
      matchId: "practice-match-1",
      botWon: true,
    });
    assert.ok(won, `${bot.id} produced no winning line`);
    assert.equal(won.botId, bot.id);
    assert.equal(won.event, "win", "the bot's victory is a `win` line");
    assert.equal(won.durationMs, DIALOGUE_DIRECTOR_DEFAULTS.endingDurationMs);
    assert.ok(
      SOLITAIRE_BOT_DIALOGUE[bot.id].lines.win.includes(won.key),
      `${bot.id}'s win line is not from its own library`,
    );

    const lost = solitaireResultLine({
      botId: bot.id,
      matchId: "practice-match-1",
      botWon: false,
    });
    assert.ok(lost, `${bot.id} produced no losing line`);
    assert.equal(lost.event, "loss", "the bot's defeat is a `loss` line");
    assert.ok(
      SOLITAIRE_BOT_DIALOGUE[bot.id].lines.loss.includes(lost.key),
      `${bot.id}'s loss line is not from its own library`,
    );
  }
});

test("the ending line is deterministic for a match, and never mixes events", () => {
  const first = solitaireResultLine({ botId: "rookie", matchId: "m-42", botWon: true });
  const again = solitaireResultLine({ botId: "rookie", matchId: "m-42", botWon: true });
  assert.deepEqual(first, again);

  const otherMatch = solitaireResultLine({ botId: "rookie", matchId: "m-43", botWon: true });
  assert.notEqual(otherMatch.id, first.id);

  const loss = solitaireResultLine({ botId: "rookie", matchId: "m-42", botWon: false });
  assert.notEqual(loss.key, first.key);
  assert.notEqual(loss.id, first.id);
});

// ── The practice result popup ──────────────────────────────────────────────

test("the bot hero shows its portrait and plain name, not an @handle", () => {
  const result = code(RESULT_SCREEN);

  assert.match(result, /outcome === "win" && opponent\?\.isAi && opponent\.name/);
  assert.match(result, /outcome === "loss" && opponent\?\.isAi && opponent\.name/);
  assert.match(result, /data-testid="result-opponent-image"/);
  assert.match(result, /data-testid="result-opponent-strip-image"/);

  // The AI hero renders the portrait and the name without the handle prefix.
  assert.match(
    result,
    /You beat[\s\S]{0,600}\{opponentPortrait\}[\s\S]{0,600}\{opponent\.name\}/,
  );
  assert.match(
    result,
    /Defeated by[\s\S]{0,600}\{opponentPortrait\}[\s\S]{0,600}\{opponent\.name\}/,
  );
});

test("the duel hands the result screen the bot's own identity", () => {
  const page = code(PAGE);

  assert.match(page, /isAi: isPractice/);
  assert.match(
    page,
    /imageSrc: isPractice \? practiceBot\?\.avatar\?\.src \?\? null : null/,
  );
  assert.match(
    page,
    /imageAlt: isPractice \? practiceBot\?\.avatar\?\.alt \?\? null : null/,
  );
});

test("a practice result always carries the bot's ending dialog", () => {
  const page = code(PAGE);

  // The director's terminal line is preferred...
  assert.match(page, /botLine\.event === "win" \|\| botLine\.event === "loss"/);
  // ...and a settled outcome guarantees one when it is missing.
  assert.match(page, /solitaireResultLine\(\{/);
  assert.match(page, /botWon: outcome === "loss"/);
  assert.match(page, /isPractice && practiceBot && botResultLine \?/);
  assert.match(page, /testId="solitaire-bot-result-speech"/);
});

test("the result shows the bot's name and rating label beside its portrait", () => {
  const result = code(RESULT_SCREEN);

  // Portrait and the identity column are one row, so the rating sits next to
  // the face rather than floating above the name.
  assert.match(result, /\{opponentPortrait\}\s*<div className="min-w-0">/);
  assert.match(result, /\{opponent\.ratingLabel && \(/);

  const page = code(PAGE);
  assert.match(
    page,
    /ratingLabel: isPractice \? practiceBot\?\.ratingLabel \?\? null : null/,
  );
});

test("the practice lobby previews the same portrait and ending dialog", () => {
  const page = code(LOBBY);

  // The picker's cards already carry the roster portrait; the preview adds the
  // exact ending dialog the result popup will show for that bot.
  assert.match(page, /<BotAvatar bot=\{bot\}/);
  assert.match(page, /const resultPreview = solitaireResultLine\(\{/);
  assert.match(page, /botWon: false/);
  assert.match(page, /data-testid=\{`solitaire-result-preview-\$\{bot\.id\}`\}/);
  assert.match(page, /<BotSpeech[\s\S]{0,200}line=\{resultPreview\}/);
});

test("Glitch speaks the ranked result only; the bot owns the practice result", () => {
  const page = code(PAGE);
  assert.match(page, /showGlitch=\{!isPractice\}/);

  // The bot's speech row is rendered from the shared screen's main flow, and
  // the match strip goes silent while the result is mounted (one voice only).
  assert.match(page, /line=\{phase === "result" \? null : botLine\}/);
});
