// tests/result-elo.test.mjs
//
// The result popup's "Match Details" shows each side's score. These tests pin
// the Elo line added beside those scores, in the two modes that must have it:
// Solitaire Duel against a bot (practice) and Solitaire Duel ranked.
//
// Three things have to stay true, and each is a different file:
//   1. the shared screen prints a side's Elo when one is supplied,
//   2. the duel result page supplies one per side (bot roster strength in
//      practice, both players' rated values in ranked),
//   3. the match snapshot actually carries those ratings, so the page is not
//      inventing them.
//
// Run: node --import tsx --test tests/result-elo.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");

const SCREEN = "src/components/result/PvpResultScreen.jsx";
const PAGE = "src/app/casino/solitaire-duel/[matchId]/PageClient.tsx";
const ROUTE = "src/app/api/solitaire-duel/match/[matchId]/route.ts";

test("the shared result screen prints a side's Elo when it is given one", () => {
  const src = read(SCREEN);
  assert.match(src, /side\.elo !== null/);
  assert.match(src, /Number\.isFinite\(Number\(side\.elo\)\)/);
  assert.match(src, /formatNumber\(side\.elo\)/, "the value is formatted, never raw");
  assert.ok(src.includes(" Elo"), "the row names the metric");
  assert.match(src, /data-testid="result-side-elo"/);
});

test("a side without an Elo renders nothing extra (no 'undefined Elo')", () => {
  const src = read(SCREEN);
  // The guard must sit on the whole block, not only inside the text node, so
  // games that never pass `elo` keep their bytes-identical layout.
  assert.match(
    src,
    /side\.elo !== null &&\s*\n\s*side\.elo !== undefined &&\s*\n\s*Number\.isFinite/,
  );
});

test("practice supplies the bot's roster rating and the account's own Elo", () => {
  const src = read(PAGE);
  assert.match(src, /const isPractice = Boolean\(match\?\.isAi\)/);
  assert.match(
    src,
    /isPractice\s*\n?\s*\?\s*practiceBot\?\.rating \?\? null/,
    "the bot side must read the roster number, not a label",
  );
  assert.match(src, /elo: myElo/);
  assert.match(src, /elo: opponentElo/);
});

test("ranked maps each seat to its own rating", () => {
  const src = read(PAGE);
  assert.match(src, /match\.ratings\[mySeatKey\]/);
  assert.match(
    src,
    /mySeatKey === "player1" \? "player2" : "player1"/,
    "the opponent must read the OTHER seat, never the viewer's own number",
  );
});

test("the match snapshot carries per-seat Elo, read in one query", () => {
  const src = read(ROUTE);
  assert.match(src, /getRatingMapsForUsers/);
  assert.match(src, /ratings = \{/);
  assert.match(src, /player1: ratingFor\(result\.match\.player1Id\)/);
  assert.match(src, /player2: ratingFor\(result\.match\.player2Id\)/);
  // Only real accounts have player_ratings rows; the bot sentinel never does.
  assert.match(src, /id\.startsWith\("user_"\)/);
  // A rating read is cosmetic: it must not be able to fail the board payload.
  assert.match(
    src,
    /} catch \{\s*\n\s*ratings = null;/,
    'a failed rating read must degrade to "no Elo", not a 500',
  );
});
