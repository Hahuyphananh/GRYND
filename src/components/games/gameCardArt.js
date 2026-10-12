// src/components/games/gameCardArt.js
//
// THE GAME-CARD ART REGISTRY — one screenshot/illustration per public game,
// keyed by the game's PUBLIC PAGE slug (the same slug as `/games/<slug>` and
// as `GAME_LANDING_PAGES` in src/lib/gameLandingPages.ts).
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// The art used to be imported inside src/app/casino/PageClient.jsx, which meant
// only the lobby could draw a game card. The FAQ's games directory renders the
// SAME card (src/components/games/GameCard.jsx), so the art had to move out of
// one page and into a module both surfaces import. One registry also means the
// two surfaces cannot show different art for the same game.
//
// ── Keying ────────────────────────────────────────────────────────────────
//
// Keys are landing-page slugs, not lobby `leaderboardKey`s: the lobby's keys are
// game ids and two of them differ (the lobby's Neon Flush card carries the id
// "uno"). `tests/game-landing-pages.test.mjs` asserts this map covers every
// public game and nothing else, so a game cannot reach a card surface without
// art — and, just as importantly, a stale key cannot linger here after a game
// is retired from the catalogue.
//
// `neon-flush` and `uno` deliberately share one image: they are two public
// pages for the same colour-and-number card game (both `leaderboardKey: "uno"`),
// and the lobby ships a single card for the pair.

import chessArt from "../../images/chessimage.png";
import kenoArt from "../../images/kenoimage.png";
import unoArt from "../../images/uno game div.webp";
import rpsArt from "../../images/rockpaperscissorsimage.png";
import fourInARowArt from "../../images/four-in-a-row-card.png";
import laneRunnerArt from "../../images/lanerushimage.png";
import poolMastersArt from "../../images/poolmastersimage.png";
import hexDuelArt from "../../images/hexduelimage.png";
import oddsArt from "../../images/odds.svg";
import precisionArt from "../../images/precision.svg";
import dotsAndBoxesArt from "../../images/dots-and-boxes.svg";
import miniGolfArt from "../../images/mini-golf-card.svg";
import speedTypingArt from "../../images/speed-typing-card.svg";
import ticTacToeArt from "../../images/tic-tac-toe-card.svg";
import solitaireDuelArt from "../../images/solitaire-duel-card.svg";
import sudokuDuelArt from "../../images/sudoku-duel-card.svg";
import barricadeArt from "../../images/barricade-card.svg";
import towerArenaArt from "../../images/towersimage.jpg";
import minesPvpArt from "../../images/minesimage.png";
import memoryGridArt from "../../images/memorygridimage.png";

export const GAME_CARD_ART = {
  "mines-pvp": minesPvpArt,
  "memory-grid": memoryGridArt,
  chess: chessArt,
  keno: kenoArt,
  "neon-flush": unoArt,
  rps: rpsArt,
  "tower-arena": towerArenaArt,
  "four-in-a-row": fourInARowArt,
  "lane-runner": laneRunnerArt,
  "pool-masters": poolMastersArt,
  precision: precisionArt,
  "dots-and-boxes": dotsAndBoxesArt,
  "mini-golf": miniGolfArt,
  "speed-typing": speedTypingArt,
  "tic-tac-toe": ticTacToeArt,
  "solitaire-duel": solitaireDuelArt,
  "sudoku-duel": sudokuDuelArt,
  odds: oddsArt,
  "hex-duel": hexDuelArt,
  uno: unoArt,
  barricade: barricadeArt,
};
