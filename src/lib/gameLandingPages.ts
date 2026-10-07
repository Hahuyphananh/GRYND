// src/lib/gameLandingPages.ts
//
// THE GAME LANDING-PAGE CATALOG — one entry per public `/games/<slug>` page.
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// The public game URL used to be nothing but a rewrite of the authenticated
// game application: `/games/<slug>` invisibly served `/casino/<slug>`'s client
// component, so the only thing a crawler could read was a title and a Play
// button. There was no crawlable text, and a signed-out visitor landed in a
// lobby they could not use.
//
// The architecture now splits the two concerns:
//
//   /games/<slug>        → a PUBLIC, server-rendered landing page (this file)
//   /games/<slug>/play   → the AUTHENTICATED game + lobby, unchanged
//
// Everything a visitor needs to understand the game BEFORE signing in lives
// here, as data, so all 21 pages are rendered by one component
// (src/components/game-landing/GameLanding.tsx). No page duplicates JSX.
//
// ── Where the content comes from (do NOT invent mechanics) ─────────────────
//
// Every rule, number and scoring detail below is transcribed from the game's
// own server-authoritative source, which is the only authority on how it
// plays. The contract for each game is the header comment of its engine /
// constants module — `src/lib/<game>/constants.ts`, `rules.ts`, or the
// equivalent — and several have a "WHAT THIS GAME IS" block stating the
// contract in one place. If a rule changes there, it must change here.
//
// Deliberate exclusions, because they would be FALSE today:
//   * No wagering, staking, pot, rake or payout language anywhere. Tokens can
//     no longer move for a match at all — see `STAKES_RETIRED` in
//     src/lib/games/stakes.js. A competitive match is decided on skill and
//     rewarded with a per-game Elo rating and trophies (src/lib/rating.js,
//     src/lib/trophies.js).
//   * No invented reward numbers. The trophy/Elo machinery is described by
//     what it does (moves a per-game ladder), not by a delta that tuning can
//     change out from under this copy.
//
// `leaderboardKey` ties each page to its identity in the existing catalog
// (`GAME_CATALOG` in src/lib/gameTags.js, and the `RATED_GAMES` keys in
// src/lib/rating.js). tests/game-landing-pages.test.mjs asserts that link, so
// a page can never be added for a game that does not exist.

/** The canonical origin the public site is served from. */
export const SITE_ORIGIN = "https://grynd.dedyn.io";

/** One question/answer pair rendered in the landing page FAQ. */
export type GameFaqEntry = {
  q: string;
  a: string;
};

/** A public game landing page. */
export type GameLandingPage = {
  /** The `/games/<slug>` path segment — also the `/casino/<slug>` lobby dir. */
  slug: string;
  /** Short display name, as the lobby and rating boards render it. */
  name: string;
  /** The page H1, e.g. "Speed Typing — Competitive Typing Game". */
  headline: string;
  /** Grouping used for the "Related games" rail and the hub cross-links. */
  category: string;
  /**
   * The game's canonical id in the lobby/leaderboard registries — exactly the
   * `id` of the matching entry in `GAME_CATALOG` (src/lib/gameTags.js), which
   * is itself the lobby's `leaderboardKey`. Two of these games share one id
   * with an alias page (uno/neon-flush), which is why the pair is explicit
   * rather than derived.
   */
  leaderboardKey: string;
  /** Open Graph / Twitter card image. Reuses the game's existing card art. */
  ogImage: string;
  /** Meta description. Doubles as the hub card blurb. */
  shortDescription: string;
  /** Does the lobby offer an unrated practice match against the bot? */
  aiPractice: boolean;
  /** Opening explanation: what the game is, and why it is competitive. */
  introduction: string[];
  /** The actual mechanics, in the order a player meets them. */
  howToPlay: string[];
  /** How a match works — the rules the server enforces. */
  rules: string[];
  /** What decides performance / the winner. */
  scoring: string[];
  /** Genuinely useful, game-specific advice. */
  strategy: string[];
  /** Which skill the game tests. */
  competitive: string;
  /** Questions specific to this game. */
  faq: GameFaqEntry[];
  /** Slugs of other public landing pages to link to. */
  related: string[];
};

/**
 * The catalog, in the lobby's featured order (the same order as
 * `GAME_CATALOG` in src/lib/gameTags.js).
 */
export const GAME_LANDING_PAGES: readonly GameLandingPage[] = [
  {
    slug: "mines-pvp",
    name: "Mines Duel",
    headline: "Mines Duel — 1v1 Minefield Scoring Race",
    category: "Deduction",
    leaderboardKey: "mines-pvp",
    ogImage: "/images/og/mines.jpg",
    shortDescription:
      "Race another player across two separate 10×10 minefields. Safe reveals, correct flags and a full clear all score — one shared three-minute clock decides it.",
    aiPractice: true,
    introduction: [
      "Mines Duel is a simultaneous, score-vs-score minefield duel. Both players play at the same time on their OWN server-generated 10×10 board, and the two boards never share the same mine positions — you are racing your own field, not picking over a shared one.",
      "It is competitive because the clock is shared and the scoring is unforgiving: guessing costs you points, flagging well pays, and clearing the whole board is worth more than any single clever guess.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to be matched with a live opponent. A free practice match against the bot is available without an account.",
      "You and your opponent each receive your own 10×10 board with 10 mines in it. Nobody takes turns — both boards are live from the first second.",
      "Reveal tiles you believe are safe. The number on a revealed tile counts the mines touching it.",
      "Flag the tiles you believe hold a mine. Flagging is worth the mine's own value, so a correct flag on a high-value mine is worth several safe reveals.",
      "Clear your board to lock it in and bank the clear bonus — your opponent keeps playing until their own board is done.",
    ],
    rules: [
      "Strictly 1v1 and strictly simultaneous. There are no turns and no shared board.",
      "Both boards are the same size (10×10) and hold the same number of mines (10), drawn from the same value table: five 10-point mines, three 20-point, one 30-point and one 50-point mine.",
      "Mine positions are generated server-side and are never sent to a client. The values and the score are server-authoritative.",
      "One server-authoritative timer runs the whole match at 180 seconds.",
      "Your score can never drop below zero.",
      "Clearing your board awards a +100 completion bonus and permanently locks that board; the opponent continues alone until their own board is finished or the clock runs out.",
    ],
    scoring: [
      "Safe tile revealed: +5.",
      "Correctly flagged mine: the mine's value (10, 20, 30 or 50).",
      "Wrong flag: −10.",
      "Revealing a mine: −25.",
      "Clearing the board: +100, and the board locks.",
      "When both boards are complete, or the timer expires, the higher score wins; an exact tie falls through a deterministic tiebreak ladder rather than inventing a winner.",
    ],
    strategy: [
      "Weight your flags: five of the ten mines are only worth 10, but the single 50-point mine is worth ten safe reveals. Spend your riskiest read on the highest-value mine you have left.",
      "Never guess a coin-flip. A wrong flag is −10 and stepping on a mine is −25, which is more than four safe reveals earn.",
      "Read the numbers outward. A revealed 1 or 2 touching a cluster of unrevealed tiles tells you where the safe ground is, and safe ground is free points.",
      "Value the clear bonus properly. +100 for finishing usually beats grinding out a couple of extra flags, so once your board is close to solved, stop gambling.",
      "Play the clock. With 180 seconds shared and scores that only move up, an early lead means you can spend the last minute on guaranteed-safe tiles instead of on guesses.",
    ],
    competitive:
      "Mines Duel tests deduction under a clock: reading clue numbers correctly, pricing risk against a fixed scoring table, and deciding when to stop guessing and close out a board.",
    faq: [
      {
        q: "Do I share a board with my opponent?",
        a: "No. Each seat gets its own server-generated board, and the two boards can never share the same mine positions. You are scored on your own field.",
      },
      {
        q: "Is it turn-based?",
        a: "No. Both players play continuously and simultaneously. Nothing waits for your opponent.",
      },
      {
        q: "How long does a match last?",
        a: "Up to 180 seconds on one shared server clock, or until both boards are cleared — whichever comes first.",
      },
      {
        q: "Can my score go negative?",
        a: "No. Penalties apply, but the score is floored at zero.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered and no tokens change hands. Ranked matches move your per-game Elo rating and your trophy ladder instead.",
      },
    ],
    related: ["memory-grid", "lane-runner", "keno", "precision"],
  },

  {
    slug: "memory-grid",
    name: "Memory Grid",
    headline: "Memory Grid — 1v1 Memory Recall Duel",
    category: "Reflex & Recall",
    leaderboardKey: "memory-grid",
    ogImage: "/images/og/memory-grid.jpg",
    shortDescription:
      "Five rounds of pattern recall on a rising difficulty ramp. Both players memorise the same server-generated lit tiles, then rebuild the pattern from memory.",
    aiPractice: true,
    introduction: [
      "Memory Grid is a pure pattern-recall duel. One server-generated lit-tile pattern is shown to both players at the same moment; the grid then goes dark and each player rebuilds it from memory on their own blank grid.",
      "It is competitive because the pattern and the exposure time are identical for both seats — the only variable is what you can hold in your head, and the ramp gets steeper every round.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play for a live opponent, or play a free practice match against the bot.",
      "A match is exactly five rounds. Both players see the same lit-tile pattern at the same time.",
      "Phase 1 — memorise: the grid is revealed with its active tiles lit, for that round's fixed exposure time.",
      "Phase 2 — reconstruct: the grid goes dark and you tap the tiles you remember on your own blank grid.",
      "Submit when you are done. Your grid freezes and waits for your opponent; the round resolves once you have both submitted.",
    ],
    rules: [
      "Exactly five rounds, played simultaneously — nobody takes turns, and one server-generated pattern is used for both players.",
      "The difficulty ramp is fixed: round 1 is a 3×3 grid with 3 lit tiles and 2.5 s to memorise; round 2 is 4×4 with 5 tiles and 3.0 s; round 3 is 4×4 with 7 tiles and 3.0 s; round 4 is 5×5 with 10 tiles and 3.5 s; round 5 is 5×5 with 14 tiles and 4.0 s.",
      "If the five rounds finish with exactly level cumulative scores, a sixth tiebreak round is dealt on a harder grid: 6×6 with 18 lit tiles and 4.0 s.",
      "If the tiebreak round is also level, the match is a draw.",
      "The pattern is generated server-side from the match seed and is hidden from every client outside its own round's memorise phase.",
      "A player who never submits is auto-locked so the round cannot hang on them.",
    ],
    scoring: [
      "A round scores the percentage of grid cells you reconstructed correctly, out of 100, rounded to one decimal place.",
      "Every round uses the same 0–100 scale — there are no round multipliers and no growing maximums.",
      "The match goes to the higher cumulative total after five rounds.",
      "Speed tiers are recorded for feedback only. Finishing first earns nothing.",
    ],
    strategy: [
      "Chunk the pattern instead of memorising tiles one at a time. A row, a diagonal or a 2×2 cluster is one object in memory; fourteen loose tiles are fourteen things to lose.",
      "Anchor on structure. The corners, the centre and the outer ring stay in place between rounds even as the grid grows, so build from the anchors outward.",
      "Do not rush the submit. The round only ends when both players are in, and points come from accuracy alone — so use whatever time you need.",
      "On the 5×5 and 6×6 grids, count. Knowing you still owe four tiles is often what stops you submitting a pattern that is one tap short.",
      "Practise the ramp order deliberately: the jump from 3 tiles to 14 across five rounds is the whole difficulty curve, so getting used to holding a dozen positions is the skill to train.",
    ],
    competitive:
      "Memory Grid measures visual working-memory capacity and how fast you can encode a pattern before the lights go out — a one-shot, no-second-chance recall test against another person on identical input.",
    faq: [
      {
        q: "Is this a card-matching pairs game?",
        a: "No. Memory Grid is a pattern-recall duel: five rounds of memorise-then-rebuild on a fixed difficulty ramp, scored on the percentage of cells you get right.",
      },
      {
        q: "Does finishing first earn points?",
        a: "No. Speed is recorded for feedback only; points come solely from accuracy. Submitting early does not help your score.",
      },
      {
        q: "What happens if we tie?",
        a: "A sixth tiebreak round is dealt on a harder 6×6 grid with 18 lit tiles. If that is level too, the match is a draw.",
      },
      {
        q: "Do we see the same pattern?",
        a: "Yes. One server-generated pattern is used for both seats in each round, revealed at the same moment.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. No wager, no tokens. Ranked matches count toward this game's Elo rating and trophy ladder.",
      },
    ],
    related: ["mines-pvp", "lane-runner", "sudoku-duel", "speed-typing"],
  },

  {
    slug: "chess",
    name: "Chess",
    headline: "Chess — Competitive 1v1 Chess Online",
    category: "Classic Strategy",
    leaderboardKey: "chess",
    ogImage: "/images/og/chess.jpg",
    shortDescription:
      "Play full-rules chess against a real opponent or the built-in bot. Every move is validated server-side, and ranked games feed a dedicated chess Elo rating.",
    aiPractice: true,
    introduction: [
      "GRYND runs a full-rules game of chess with a dedicated, independent rating: your chess Elo is its own ladder and is never mixed with another game's.",
      "It is competitive in the oldest sense — there is no randomness anywhere in the game, so a result is a pure record of who calculated and planned better.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to be matched with another player, or take a free practice game against the bot.",
      "Select a piece to see its legal destination squares, then pick a destination to move.",
      "The position is validated by the server, so illegal moves are simply not available to you.",
      "Compute, move, and try to force checkmate before your opponent does.",
    ],
    rules: [
      "Standard chess movement for all pieces. Castling, en passant and pawn promotion are all supported.",
      "A move that would leave your own king in check is illegal.",
      "Checkmate ends the game immediately in the checkmating player's favour.",
      "Stalemate, insufficient material, and the standard repetition and fifty-move rules resolve the game as a draw.",
      "Matches are strictly 1v1. AI practice games are unrated and never affect your Elo or trophies.",
      "Leaving a live match concedes it.",
    ],
    scoring: [
      "Delivering checkmate wins the game.",
      "A drawn ending is recorded as a draw, and a draw moves no rating.",
      "Wins and losses in a ranked match move your per-game chess Elo rating and your chess trophy total.",
      "Only ranked games against another player affect progression — practice games against the bot are free and unrated.",
    ],
    strategy: [
      "Fight for the centre early. A knight on a central square controls far more of the board than one on the rim.",
      "Develop your pieces before you start attacking. Moving the same piece twice in the opening usually just wastes a tempo.",
      "Castle early. It is the cheapest way to get your king safe and your rook into the game in one move.",
      "Before every exchange, count attackers and defenders. A piece that is attacked more times than it is defended is a piece you are about to lose.",
      "Look for the forcing move first when you are on the attack: a check, a capture or a threat limits your opponent's replies to a much smaller set.",
      "In worse positions, trade pieces; in better positions, keep them. Fewer pieces on the board usually means the stronger side has an easier time converting.",
    ],
    competitive:
      "Chess tests calculation, planning and pattern recognition. Because nothing is drawn or rolled, a long win rate is an honest measure of improvement — which is why GRYND gives it its own Elo ladder.",
    faq: [
      {
        q: "Do I need an account to play?",
        a: "You can read this page and explore the site without one, but a ranked game against another player needs a signed-in account. A free practice game against the bot is the entry point if you just want to try it.",
      },
      {
        q: "Does chess use the same rating as the other games?",
        a: "No. Ratings are per-game and independent. Your chess Elo lives in its own ladder and is never affected by results in other games.",
      },
      {
        q: "Can I play against the computer?",
        a: "Yes — the lobby offers a bot opponent. Bot games are unrated: they do not change your Elo or your trophies.",
      },
      {
        q: "What happens if both players just shuffle pieces?",
        a: "The standard repetition and fifty-move rules apply, so a game with no progress is resolved as a draw.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. There is no wager and no entry cost of any kind.",
      },
    ],
    related: ["sudoku-duel", "hex-duel", "tic-tac-toe", "four-in-a-row"],
  },

  {
    slug: "keno",
    name: "Keno",
    headline: "Keno Duel — 1v1 Survival Reaction Game",
    category: "Reflex & Recall",
    leaderboardKey: "keno",
    ogImage: "/images/og/keno.jpg",
    shortDescription:
      "Not a lottery — a survival duel. Three lives each, one tile lit at a time, and a window that tightens with every claim until it is pure reaction time.",
    aiPractice: true,
    introduction: [
      "GRYND's Keno is a reaction survival duel, not a number draw. Both players start with three lives, one tile on a 40-tile board lights up for both of them at once, and you lose a life only if you fail to tap it before its window closes.",
      "It is competitive because the window shrinks every time either player claims a tile: early rounds are readable, late rounds are decided in half a second. You are playing the clock as much as your opponent.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Both players begin with three lives.",
      "One tile at a time lights up on the shared 1–40 board. Both players can tap it.",
      "Tapping in time costs you nothing. Missing the window costs YOU one life — it never takes a life from your opponent.",
      "Keep going until one player's lives reach zero. Beat your opponent to tiles as well: claimed tiles decide the match if the board is exhausted first.",
    ],
    rules: [
      "Both players start with 3 lives.",
      "One tile is lit at a time, drawn from the 1..40 board and never repeated during a match.",
      "The reaction window starts at 3 seconds for the first tile and tightens by 100 ms for every tile either player has claimed, down to a floor of 0.5 seconds.",
      "You lose a life only for your own miss — that is, for not tapping the lit tile before its window closed. Tapping never costs the opponent anything.",
      "Both players tap: nobody loses a life. One taps: only the silent player loses one. Neither taps: both lose one — the both-miss.",
      "A player whose lives reach zero is eliminated and their opponent takes the match.",
      "If both players are eliminated by the same both-miss, the match is a draw rather than an invented winner.",
      "If the board is exhausted before anyone is eliminated, the player with more lives wins; equal lives is a draw.",
    ],
    scoring: [
      "The match is decided by lives, not by points: the first player to reduce their opponent to zero lives wins.",
      "Claimed tiles are the tiebreak — if the whole board is exhausted, more lives wins and the tile count settles nothing else.",
      "A both-miss that eliminates both players at once is recorded as a draw.",
    ],
    strategy: [
      "Watch the board, not the tile you just hit. The next tile is drawn from anywhere in the 1..40 range, so a fixed gaze on the last position is how the late misses happen.",
      "Expect the endgame to be reflex-only. At 0.5 seconds per window there is no time to plan, so treat the last few tiles as a pure reaction test and stay ready.",
      "Claim tiles even when you do not have to think about it. Beating your opponent to a tile is how you win an exhausted board, and both misses are the only real danger.",
      "Never coast on a life lead. The both-miss costs both players a life at the same time, so a one-life cushion does not protect you from a level ending.",
      "Track the shrinking window. Every claim either player makes shortens it by 100 ms, so the match gets faster for you both — and the player who adjusts first keeps their lives.",
    ],
    competitive:
      "Keno Duel tests visual reaction time and sustained attention. Because the window tightens on every claim, it rewards a player who can stay fast under pressure instead of one who starts fast and fades.",
    faq: [
      {
        q: "Is this the usual Keno number draw with prizes?",
        a: "No. GRYND's Keno is a head-to-head survival duel: three lives, one lit tile at a time, and a shrinking reaction window. Nothing is wagered and there is no draw-based payout.",
      },
      {
        q: "Do I lose a life if my opponent taps first?",
        a: "No. You lose a life only if you miss the window yourself. Another player being faster never directly costs you a life.",
      },
      {
        q: "What happens if neither of us taps?",
        a: "You both lose a life — that is the both-miss, and it is the one situation that can take a life from both players at once.",
      },
      {
        q: "What if the last life is lost by both players at once?",
        a: "The match is recorded as a draw. Neither player is credited with a win — no winner is invented to break a genuine tie.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. There is no entry cost, and ranked results move your per-game Elo and trophy ladder.",
      },
    ],
    related: ["speed-typing", "precision", "memory-grid", "mines-pvp"],
  },

  {
    slug: "neon-flush",
    name: "Neon Flush",
    headline: "Neon Flush — 1v1 Card Duel Online",
    category: "Card Games",
    leaderboardKey: "uno",
    ogImage: "/images/og/neon-flush.jpg",
    shortDescription:
      "Neon Flush is GRYND's neon-skinned colour-and-number card duel: match the colour in force or the top card's value, and empty your hand before your opponent.",
    aiPractice: true,
    introduction: [
      "Neon Flush is a two-player shedding card duel built on the classic colour-and-number rules, dressed in GRYND's neon theme. Your goal is simple: be the first to get rid of every card in your hand.",
      "It is competitive because the colour in force is a decision, not a property of the card — a well-timed wild can strand an opponent holding a hand they cannot play.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice game against the bot.",
      "On your turn, play a card that matches either the colour currently in force or the value of the top card of the discard pile.",
      "If you have nothing playable, draw from the deck.",
      "Wilds let you declare a new colour, and the colour in force follows that declaration — not the printed colour of the card underneath.",
      "Empty your hand to win.",
    ],
    rules: [
      "A card is playable if it matches the colour currently in force or the value of the top card of the discard pile.",
      "A wild is always playable.",
      "A Wild Draw Four is only legal when you hold no card matching the colour currently in force — it is a restriction, not a free play.",
      "When the top card is a wild, only colour-matching cards are playable. Value matching is meaningless there, because a wild has no number.",
      "The colour in force after a wild is the colour the player declared, not the colour printed on the wild.",
      "The deck and the hands are managed server-side; the client renders what the server says is in your hand.",
    ],
    scoring: [
      "The match is won by the first player to empty their hand.",
      "There are no points to accumulate and nothing to bank — the win condition is the whole score.",
      "A ranked win or loss moves your per-game rating for this family of game and your trophy ladder.",
    ],
    strategy: [
      "Hold your wilds for when you are stuck. A wild played early just gives your opponent a colour to work with; a wild played late is often the card that ends the game.",
      "Before you declare a colour, look at your own hand. Declaring the colour you hold most of is how you keep a chain of plays going.",
      "Use your draw cards to stall. Making your opponent draw is both a tempo hit and extra cards they have to shed before they can win.",
      "Keep colour flexibility as long as you can. A hand spread evenly across four colours survives any declaration; a hand stacked on one colour dies to a single wild.",
      "Count what has gone. When a colour runs thin in the discard pile, declaring it is usually safe, and the cards you are holding in it become dead weight for your opponent instead.",
    ],
    competitive:
      "Neon Flush tests hand management and colour planning: sequencing what you play, deciding when a wild is worth spending, and choosing a declaration that helps you more than it helps your opponent.",
    faq: [
      {
        q: "Can I play Wild Draw Four whenever I want?",
        a: "No. It is only legal when you hold no card matching the colour currently in force. The rule is enforced, so the card will simply not be playable otherwise.",
      },
      {
        q: "What decides which cards I may play?",
        a: "Two things: the colour currently in force and the value of the top card of the discard pile. After a wild, only the declared colour matters.",
      },
      {
        q: "Do I need an account?",
        a: "A ranked game against another player does. A free practice game against the bot is available if you want to try the rules first.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered and no tokens change hands. Competitive results move your Elo and trophies.",
      },
    ],
    related: ["uno", "solitaire-duel", "dice-flush", "odds"],
  },

  {
    slug: "rps",
    name: "Rock-Paper-Scissors",
    headline: "Rock-Paper-Scissors — Best-of-Seven PvP Duel",
    category: "Mind Games",
    leaderboardKey: "rps",
    ogImage: "/images/og/rps.jpg",
    shortDescription:
      "Best-of-seven Rock-Paper-Scissors against a live opponent. One round takes a click; the match is won by reading patterns, not by luck.",
    aiPractice: true,
    introduction: [
      "This is Rock-Paper-Scissors played as a best-of-seven duel against a live opponent, with a full match record behind it instead of a single throw.",
      "It is competitive because over seven rounds the game stops being random. Humans are measurably predictable, and a player who notices and exploits that wins more than they lose.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to be matched with another player, or play the free practice mode against the bot.",
      "Each round, both players pick rock, paper or scissors at the same time — neither choice is revealed until both are in.",
      "Rock beats scissors, scissors beats paper, and paper beats rock.",
      "Identical picks are a drawn round: nobody scores it.",
      "The first player to win four rounds takes the match.",
    ],
    rules: [
      "Best-of-seven format: a maximum of seven rounds, and the match ends as soon as one player has won four.",
      "Both players choose simultaneously. Your pick is not sent to your opponent until both have committed.",
      "Rock beats scissors, scissors beats paper, paper beats rock.",
      "Identical picks are a draw round and award neither player a point.",
      "Rounds continue until a player reaches four wins.",
    ],
    scoring: [
      "One round win is one point. Drawn rounds score for nobody.",
      "Four round wins takes the match — that is the entire scoring model.",
      "A ranked match result moves your per-game rating and your trophies for this game.",
    ],
    strategy: [
      "Expect rock to open. It is the most common first throw among human players, so paper is a strong opener against an unknown opponent.",
      "Do not repeat a losing throw. Most players change after losing, and the change is usually to the throw that would have beaten their last one.",
      "Watch for repeats after wins. A player who just won with paper tends to throw paper again, which makes scissors the profitable reply.",
      "Refuse to be the predictable one. If you notice a pattern in your own throw sequence, break it before your opponent prices it in.",
      "Mix your throws deliberately. Any fixed strategy loses to its counter, so randomness is not laziness here — it is the correct play, and the skill is in staying unpredictable while still exploiting your opponent's tells.",
    ],
    competitive:
      "Rock-Paper-Scissors tests opponent modelling. The rules are trivial; reading a human being's tendencies across seven rounds is not.",
    faq: [
      {
        q: "Isn't this pure luck?",
        a: "A single throw is close to a coin flip, which is exactly why matches are best-of-seven. Over a full match, pattern-reading and unpredictability dominate.",
      },
      {
        q: "How many rounds can a match go?",
        a: "Seven at most — the match ends as soon as one player has won four.",
      },
      {
        q: "Is there a bot to practise against?",
        a: "Yes. There is a free practice mode, so you can learn the flow before playing a ranked match.",
      },
      {
        q: "Is it free?",
        a: "Yes. No wager, no tokens; ranked results drive Elo and trophies.",
      },
    ],
    related: ["odds", "tic-tac-toe", "neon-flush", "uno"],
  },

  {
    slug: "tower-arena",
    name: "Tower Arena",
    headline: "Tower Arena — 1v1 Block Stacking Duel",
    category: "Stacking",
    leaderboardKey: "tower-arena",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Head-to-head block stacking: pieces fall onto the tallest support beneath them and lock in place. Force your opponent into a placement that crosses the ceiling.",
    aiPractice: true,
    introduction: [
      "Tower Arena is a turn-based stacking duel on a shared tower. Pieces drop vertically onto the highest support below their footprint and immediately become fixed, so every placement permanently narrows the space available to both players.",
      "It is competitive because the board is only eight columns wide and the ceiling is fixed: the tower is going to collapse, and the only question is whose turn it collapses on.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Players alternate turns. There are two seats, and no more.",
      "On your turn you receive a piece and choose where to place it across the board.",
      "The piece falls vertically onto the highest support beneath its footprint and becomes fixed at that level.",
      "Play continues until someone cannot place without crossing the ceiling.",
    ],
    rules: [
      "Strictly 1v1, turn-based, with alternating turns.",
      "The board is 8 columns wide and the ceiling sits at a fixed height of 24 units.",
      "Each block is one unit tall. Seven shapes are in play: I, L, T, square, short, long and big.",
      "A piece falls onto the highest support below its footprint. There is no overhang allowance and no sliding, so the piece lands exactly where you choose.",
      "The only losing placement is one that crosses the ceiling — there is no other way to lose a piece.",
      "The piece pool is sized for exactly two players, so each cycle offers two pieces of every shape.",
    ],
    scoring: [
      "You win by surviving. The first player who cannot place a piece without crossing the ceiling loses the match.",
      "There are no points to accumulate — the tower itself is the scoreboard.",
      "A ranked result moves your per-game rating and your trophies for this game.",
    ],
    strategy: [
      "Keep the surface flat. Isolated towers are what kill you, because they leave the next wide piece with nowhere supported to land.",
      "Think two pieces ahead. The pool offers every shape twice per cycle, so a shape you cannot place now is a shape that is coming back.",
      "Never bury the last usable column. If your placement closes the only lane a big piece could sit on, you have made your own next turn impossible.",
      "Spend the awkward shapes first. Placing the L and T pieces early, while there is still flat ground for them, is far easier than placing them onto an uneven stack later.",
      "Read the ceiling constantly. Knowing how many rows are left turns 'where can this piece go' into 'where can this piece go without ending my match'.",
    ],
    competitive:
      "Tower Arena tests spatial planning under a constraint that only gets tighter. It is a resource game: every placement you make is a placement your opponent can no longer use.",
    faq: [
      {
        q: "Is this the multi-player tower mode?",
        a: "No. Tower Arena is strictly 1v1 — two seats, alternating turns. The shared tables were retired.",
      },
      {
        q: "How do you actually lose?",
        a: "The only losing placement is one that crosses the ceiling. There is no overhang and no sliding, so a piece cannot be rescued after you commit to it.",
      },
      {
        q: "Does each player get the same pieces?",
        a: "The pool is sized for two players and offers two pieces of every shape per cycle, so the sequence is shared rather than dealt separately.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. No wagering and no tokens — ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["four-in-a-row", "hex-duel", "dots-and-boxes", "mines-pvp"],
  },

  {
    slug: "four-in-a-row",
    name: "Four-In-A-Row",
    headline: "Four-In-A-Row — 1v1 Connect Four Online",
    category: "Classic Strategy",
    leaderboardKey: "four-in-a-row",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "The classic drop-the-disc duel on a 7-column, 6-row board. Take the centre, build two threats at once, and get four in a row before your opponent.",
    aiPractice: true,
    introduction: [
      "Four-In-A-Row is the classic disc-dropping duel: seven columns, six rows, and a race to line up four of your own discs in a row.",
      "It is competitive because the game has no hidden information and no randomness — the first player to look further ahead wins, and mistakes are permanent and visible.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice game against the bot.",
      "On your turn, choose a column and drop your disc into it.",
      "The disc falls to the lowest empty cell in that column, so the column fills from the bottom up.",
      "Players alternate turns. You may only drop into a column that is not already full.",
      "Line up four of your discs — horizontally, vertically or diagonally — to win.",
    ],
    rules: [
      "The board is 7 columns wide and 6 rows tall.",
      "A disc always falls to the lowest empty cell of the chosen column; discs never move once placed.",
      "A full column accepts no more discs, so losing access to a column is permanent.",
      "The first player to align four of their own discs in a straight line wins — in any row, in any column, or along either diagonal.",
      "If all 42 cells are filled with no four-in-a-row, the game is a draw.",
    ],
    scoring: [
      "Four in a row wins the game outright.",
      "A completely full board with no line is a draw.",
      "Ranked results move your per-game rating and your trophy ladder for this game.",
    ],
    strategy: [
      "Take the centre column first. It sits inside more potential four-lines than any other column, so it is the strongest square on the board.",
      "Always answer the disc underneath a threat. Blocking the immediate vertical line your opponent is building is the move you cannot skip.",
      "Build two threats at once rather than one. A single threat is easy to block; two threats in different columns cannot both be answered.",
      "Watch the diagonals. Most beginner losses come from a diagonal that nobody was watching because both players were scanning rows and columns.",
      "Plan your own stack. Because discs fall to the bottom, three discs you control in a column are only one drop away from a win, and your opponent can see it coming.",
    ],
    competitive:
      "Four-In-A-Row tests foresight and threat construction with perfect information — it is a pure planning game where a two-move lead is usually the difference.",
    faq: [
      {
        q: "How big is the board?",
        a: "Seven columns and six rows — 42 cells, filled bottom-up.",
      },
      {
        q: "What happens if the board fills up?",
        a: "The game is a draw. There is no tiebreak; a full board with no four in a row is recorded as a draw.",
      },
      {
        q: "Can I play the computer?",
        a: "Yes. There is a bot opponent, and those games are unrated — they do not change your Elo or trophies.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered — ranked results move your per-game Elo rating and your trophy ladder instead.",
      },
    ],
    related: ["tic-tac-toe", "tower-arena", "hex-duel", "dots-and-boxes"],
  },

  {
    slug: "lane-runner",
    name: "Lane Rush Duel",
    headline: "Lane Rush Duel — 1v1 Glass Bridge Race",
    category: "Risk & Memory",
    leaderboardKey: "lane-runner",
    ogImage: "/images/og/lane-runner.jpg",
    shortDescription:
      "Cross the same ten-row glass bridge as your opponent, alternating turns. One bad tile per row, and every broken tile stays broken for the rest of the match.",
    aiPractice: true,
    introduction: [
      "Lane Rush Duel is a race across a shared, ten-row bridge. Each row hides exactly one bad tile, and it never regenerates — so every tile either player breaks is knowledge you both keep.",
      "It is competitive because the bridge is shared information. A player who remembers which tiles are already proven safe crosses rows for free, and a player who forgets re-breaks the same glass.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Both players climb the same bridge. Exactly 10 rows, and exactly one bad tile in each row.",
      "On your turn you pick a tile on the row you are currently standing on.",
      "A safe tile crosses that row and you keep your turn — the choice window resets and you keep going.",
      "A bad tile breaks permanently, sends your attempt back to row 1, and passes the turn to your opponent.",
      "Cross row 10 and the match is over in your favour.",
    ],
    rules: [
      "One bridge per match: exactly 10 rows, each with exactly one bad tile. It is generated once and never regenerated mid-match.",
      "Alternating turns. The bridge and the tile layout are server-authoritative.",
      "A safe tile advances you one row and keeps the turn; the tile-choice window resets for the new row.",
      "A bad tile stays broken for the rest of the match, ends your attempt, returns you to row 1, and hands the turn over.",
      "The tile-choice window is server-authoritative. Letting it expire ends your attempt exactly like a bad tile, except it breaks no tile.",
      "Each player has a limited number of memory flags. A flag can only be placed on a tile you personally landed on safely, is visible to both players, is append-only, and never consumes your turn.",
      "The chosen difficulty decides the tile width of every row — narrower tiles mean fewer places to guess.",
    ],
    scoring: [
      "The first player to cross row 10 wins the match immediately.",
      "There is no point total. Progress across the bridge is the only score.",
      "A ranked result moves your per-game rating and your trophies for this game.",
    ],
    strategy: [
      "Flag every tile you prove safe. The flags are public, so they help you twice: they stop you re-testing glass, and they quietly tell your opponent nothing they could not have watched anyway.",
      "Remember the broken tiles across your opponent's attempts. A tile your opponent broke is a tile you never need to test again on that row.",
      "Push your streak while you have it. Keeping the turn is the whole advantage of the mechanic — a safe pick resets your window and lets you climb multiple rows in one turn.",
      "When the window is tight, commit to the tile you were already considering. Starting a fresh scan as the timer drains usually ends in an expired attempt, which costs you the same progress a bad tile would.",
      "Accept that the bridge gets easier for both players. Because broken tiles stay broken, late-match rows are mostly already solved — the contest becomes who remembers the solved ones.",
    ],
    competitive:
      "Lane Rush Duel tests memory of shared information combined with risk selection under a server-enforced clock. The tiles you and your opponent break are a public notebook, and the winner is usually the player who reads it.",
    faq: [
      {
        q: "Do we cross the same bridge?",
        a: "Yes. One bridge per match, shared by both players, with exactly one bad tile in each of its ten rows.",
      },
      {
        q: "Does a bad tile reset my progress?",
        a: "Yes. Your attempt ends and you go back to row 1. The tile you broke stays broken, so it is a permanent loss for whoever runs into it next — including you.",
      },
      {
        q: "What are the memory flags for?",
        a: "Marking tiles you have personally landed on safely. They are visible to both players, they are append-only, and placing one never uses up your turn.",
      },
      {
        q: "What happens if I run out of time to choose?",
        a: "The attempt ends exactly as if you had stepped on a bad tile, except no tile is broken. The window is enforced by the server, not by your browser.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered; ranked results move your Elo and trophies.",
      },
    ],
    related: ["memory-grid", "mines-pvp", "keno", "precision"],
  },

  {
    slug: "pool-masters",
    name: "Pool Masters",
    headline: "Pool Masters — 1v1 Online Pool",
    category: "Physics",
    leaderboardKey: "pool-masters",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Eight-ball pool against a live opponent on a physics-driven table. Six pockets, full foul rules, and an aim guide that shares its verdict with the referee.",
    aiPractice: true,
    introduction: [
      "Pool Masters is eight-ball pool played shot-for-shot against another person on a full physics table with six pockets.",
      "It is competitive because the ruleset is complete and enforced: groups, fouls and ball-in-hand are all real, so a match is decided by positioning and shot selection as much as by potting ability.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to be matched with another player, or take a free practice match against the bot.",
      "Pull the cue back to set your power and give the cue ball a direction, then release to shoot.",
      "The table, the rails and the balls are simulated by the server — the angle and the power are the only inputs you supply.",
      "Pot a coloured ball on an open table to be assigned your group: solids (1–7) or stripes (9–15).",
      "Clear your group, then pot the 8-ball to win.",
    ],
    rules: [
      "The table has six pockets and fifteen numbered object balls plus the cue ball.",
      "The table is open until the first coloured ball is legally potted — that pot assigns groups: the shooter takes solids if it was 1–7, or stripes if it was 9–15.",
      "On your turn the cue ball must first contact one of your own group's balls (any object ball once your group is cleared).",
      "Striking the 8-ball first is a foul while the table is open.",
      "After contact, either a ball must be potted or some ball must reach a rail, or the shot is a foul.",
      "A cue-ball scratch is a foul. Every foul gives the opponent ball in hand.",
      "Potting one of your own group's balls legally keeps you at the table.",
      "Pot the 8-ball after clearing your group to win — but doing so on a foul or a scratch hands the win to your opponent instead.",
    ],
    scoring: [
      "The match is won by potting the 8-ball legally, once your own group is cleared.",
      "Potting the 8-ball while you still have group balls left — or on any foul or scratch — loses the match for the shooter.",
      "Ranked results move your per-game rating and your trophy ladder for this game.",
    ],
    strategy: [
      "Play for position, not just for the pot. Where the cue ball finishes decides your next shot, and a straight-ish next shot beats a spectacular one that leaves you snookered.",
      "Keep the cue ball off the rails. Rails are where the shot you wanted turns into a foul.",
      "When the table is open, take the shot that assigns you the easier group. Committing to a group you cannot clear is a slow loss.",
      "Take the straightforward pot when it is there. Missing an ambitious shot with a foul attached gives your opponent ball in hand, which is usually a run of shots.",
      "Respect the 8-ball rule. Once you are on the 8, a scratch or a foul on that shot loses the match outright, so play it as safely as you can.",
    ],
    competitive:
      "Pool Masters tests shot selection and positional planning under complete physics. It is a planning game wearing an aiming game's clothes.",
    faq: [
      {
        q: "How are the groups decided?",
        a: "The table is open until a coloured ball is legally potted. The first one decides which group the shooter takes — solids for 1–7, stripes for 9–15.",
      },
      {
        q: "What counts as a foul?",
        a: "Scratching the cue ball; hitting the wrong ball first; striking the 8-ball first on an open table; and failing to pot a ball or reach a rail after contact. Every foul gives your opponent ball in hand.",
      },
      {
        q: "What happens if someone pots the 8-ball early?",
        a: "If the shooter has not cleared their group, or the shot was a foul or a scratch, potting the 8-ball loses the match for the shooter.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. There is no entry cost, and ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["precision", "mini-golf", "four-in-a-row", "chess"],
  },

  {
    slug: "precision",
    name: "Precision",
    headline: "Precision — 1v1 Reaction Time Duel",
    category: "Reflex & Recall",
    leaderboardKey: "precision",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "A hidden target time is rolled for every round. Stop your rocket as close to it as you can — best of five rounds, first to three wins.",
    aiPractice: true,
    introduction: [
      "Precision is a reaction-time duel with a twist: the number you are aiming for is not shown to you until the round is already over. Each round the server rolls a fresh target time, both rockets launch together, and both players press STOP whenever they judge the target has arrived.",
      "It is competitive because there is nothing to predict — the target is random every round — so the only thing that can distinguish two players is how accurately each can estimate time and commit to a click.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "The server rolls a hidden target for the round, somewhere between 2.5 and 10 seconds.",
      "A countdown runs, then both players' rockets launch at the same server-stamped instant.",
      "Press STOP the moment you judge the target has been reached. You cannot see the target while the round is live.",
      "The round is decided once both players have stopped. The closer stop takes the round.",
    ],
    rules: [
      "A match is best of five rounds: the first player to win three rounds takes it.",
      "The server rolls a fresh random target for every round, uniformly between 2.5 and 10.0 seconds.",
      "The target is kept server-side while the round is live and is only revealed when the round resolves.",
      "Both stops are server-stamped. The timing that decides a round is measured by the server, and a value supplied by a client is never the deciding number.",
      "A stop outside the permitted timing range is rejected rather than scored.",
      "Each round begins with a synchronized countdown so both players' clocks start from the same instant.",
    ],
    scoring: [
      "The round goes to the player whose stop is closest to the target — the smaller difference between the elapsed time and the target wins.",
      "The first player to win three rounds takes the match.",
      "If a player never stops, the round is graded at zero elapsed, which is the worst possible score rather than a free pass.",
    ],
    strategy: [
      "Count in your head rather than reading the timer. A steady internal count is far more repeatable than watching a fast-moving number.",
      "Aim slightly early. Most missed stops come from hesitating into a late click, and a small early stop is usually closer than a late one.",
      "Use a fixed rhythm and calibrate it. Because the target is random, your only real asset is a count you can reproduce within a couple of hundred milliseconds.",
      "Stay on the same physical setup. Your sense of time is affected by how you are sitting, how big the screen is and how you click, so consistency across rounds is worth more than any single trick.",
      "Commit on the count. The rounds that are lost are usually the ones where a player decided to stop after the moment had already passed.",
    ],
    competitive:
      "Precision tests time estimation and reaction consistency. The target is unknowable, so the game measures a physical skill rather than any knowledge of the rules.",
    faq: [
      {
        q: "Can I see the target before I stop?",
        a: "No. The target is rolled server-side for each round and stays hidden while the round is live. It is revealed when the round resolves.",
      },
      {
        q: "How many rounds is a match?",
        a: "Best of five. The first player to win three rounds takes the match.",
      },
      {
        q: "Is the target the same for both players?",
        a: "Yes. One target is rolled per round and both players stop against it on the same server clock.",
      },
      {
        q: "What if I never press stop?",
        a: "The round is graded at zero elapsed, which is the maximum possible distance from any target — so it is the worst outcome available, not a safe one.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered, and ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["keno", "speed-typing", "mines-pvp", "pool-masters"],
  },

  {
    slug: "dots-and-boxes",
    name: "Dots & Boxes",
    headline: "Dots & Boxes — 1v1 Strategy Game Online",
    category: "Classic Strategy",
    leaderboardKey: "dots-and-boxes",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Take turns drawing lines between dots and claim the boxes you close. Complete a box and you keep your turn — the whole game is about who has to open the next chain.",
    aiPractice: true,
    introduction: [
      "Dots & Boxes is the pencil-and-paper classic played properly: a 7×7 grid of dots, 84 edges, and 36 boxes to claim. Draw an edge, and if it completes a box, that box is yours.",
      "It is competitive because it is a solved-style combinatorial game in practice. Almost every finished game is decided by one thing — which player is forced to open the first long chain — and noticing that is the whole skill.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice game against the bot.",
      "The board is a 7×7 grid of dots forming 6×6 boxes — 36 in total — with 84 possible edges.",
      "On your turn, draw exactly one edge between two adjacent dots.",
      "If your edge completes the fourth side of a box, you claim it and score it.",
      "Claiming at least one box gives you another turn, so keep going until you place an edge that does not close a box.",
      "The game ends when all 84 edges have been drawn. The player with more boxes wins.",
    ],
    rules: [
      "One edge per turn. Nothing else may be drawn.",
      "When a move completes the fourth side of a box, that box is claimed by the player who drew the edge and added to their score.",
      "Completing at least one box grants another turn. Multiple boxes closed by the same edge still count as ONE bonus turn, so the game cannot loop indefinitely on a single chain.",
      "The game ends when all 84 edges have been drawn.",
      "Each turn runs on a 20-second server-enforced timer.",
    ],
    scoring: [
      "The winner is the player holding more of the 36 boxes when all edges have been drawn.",
      "Boxes are the only score — there are no bonus points for chains, streaks or speed.",
      "A ranked result moves your per-game rating and your trophies for this game.",
    ],
    strategy: [
      "Learn the two phases. Early on, all moves are safe. Once only 'dangerous' edges remain — edges that give away a box — the game is entirely about not being the player who has to move first.",
      "Play every safe edge before you play a dangerous one. Safe edges close nothing, so they cost you nothing and keep you in the safe phase for longer.",
      "Count chains before you commit. When you are forced to open one, the boxes you concede depend on the parity of the chains left on the board, so a little counting turns a loss into a draw.",
      "Open the shortest chain available. If you must give boxes away, give away as few as possible and keep the rest of the board intact.",
      "Think in sacrifices. Handing over a single box to change who has to move next is often worth far more than the box itself.",
      "Use your timer. You have twenty seconds per move, which is enough to trace the remaining board properly — most losses at this level are a missed box count, not a misclick.",
    ],
    competitive:
      "Dots & Boxes tests combinatorial planning and parity counting. It looks casual and reads as a counting game, which is exactly why good players win it consistently.",
    faq: [
      {
        q: "How many boxes and edges are there?",
        a: "A 7×7 grid of dots makes 36 boxes (6×6) and 84 possible edges. The game ends when every edge has been drawn.",
      },
      {
        q: "Do I get another turn for completing a box?",
        a: "Yes — claiming at least one box grants another turn. Multiple boxes closed by the same edge still count as one bonus turn, deliberately, so no chain can run forever.",
      },
      {
        q: "How long do I have per move?",
        a: "Twenty seconds per turn. The timer is enforced by the server.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. There is no wager and no entry cost; ranked results move your Elo and trophies.",
      },
    ],
    related: ["tic-tac-toe", "four-in-a-row", "hex-duel", "tower-arena"],
  },

  {
    slug: "mini-golf",
    name: "Mini Golf",
    headline: "Mini Golf — 1v1 Physics Putting Duel",
    category: "Physics",
    leaderboardKey: "mini-golf",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Best of five holes against a live opponent. Each seat plays its own ball, and the hole goes to whoever takes fewer strokes — aim, power and rail bounces are the whole game.",
    aiPractice: true,
    introduction: [
      "Mini Golf is a turn-based putting duel on a server-simulated course. Five holes, five difficulty tiers, and one ball per player: you keep shooting until yours is in the cup, and only then does your opponent tee off.",
      "It is competitive because your only inputs are an angle and a power value. The ball's motion — the friction, the rail bounces, the cup — is simulated by the server, so a hole is won by geometry and touch rather than by anything the client decides.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Choose your angle, then set your power between 0 and 100%.",
      "Take the shot. Your ball travels, loses speed to friction each frame and bounces off the walls at a reduced speed.",
      "Keep shooting until your ball is in the cup — a whole turn at the hole is yours to finish.",
      "Once you have holed out, your opponent gets the tee and plays their own ball to the same cup.",
    ],
    rules: [
      "A match is five holes, and the first player to win three holes takes it.",
      "Each seat plays its own ball. One player takes a complete turn at the hole, shooting until holed out, before the other player tees off.",
      "Both players must hole out before a hole is scored. That is deliberate: it lets a trailing player's strokes count, so a one-stroke lead can still be levelled.",
      "The only player-authored inputs are the shot's angle and its power (0–100).",
      "Every hole on the ramp is a different difficulty tier, and the hole layout and the ball physics are generated and simulated server-side.",
    ],
    scoring: [
      "A hole is won by the player who took fewer strokes to hole out.",
      "A hole where both players take the same number of strokes is a tie and awards neither player a hole win.",
      "The first player to win three of the five holes takes the match.",
      "If the match finishes without either player reaching three hole wins, the holes played decide it.",
    ],
    strategy: [
      "Treat power as the primary skill. Friction eats the ball's speed every frame, so an overcooked shot rattles around the rails and leaves you a long second putt.",
      "Use the rails deliberately. A bank shot is often the shortest route to a cup that is blocked by a direct line, and the walls return a predictable fraction of the speed.",
      "Play the safe two-putt when the direct line is gone. Strokes are what win holes, so a clean positional shot beats a heroic one that misses.",
      "Mind the tail end of the ramp. The five holes get progressively harder, so protect a lead on the easy holes rather than chasing a perfect score on the hard ones.",
      "Watch your opponent's line. You play the same hole to the same cup, so the shot they just missed is information about the line that does not work.",
    ],
    competitive:
      "Mini Golf tests geometric aiming and power control against a deterministic physics simulation. Because both players face the identical course, the difference is entirely in touch.",
    faq: [
      {
        q: "How many holes is a match?",
        a: "Five, and the first player to win three holes takes it.",
      },
      {
        q: "Do we share a ball?",
        a: "No. Each seat plays its own ball, taking a whole turn at the hole at a time — you keep shooting until you hole out.",
      },
      {
        q: "Why do both players have to hole out before a hole is scored?",
        a: "So a trailing player's strokes still count. If the hole ended as soon as the leader finished, a one-stroke lead could never be pulled back.",
      },
      {
        q: "What can my shot actually control?",
        a: "Only the angle and the power, from 0 to 100. Everything after that — friction, bounces, whether the ball drops — is decided by the server's simulation.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered; ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["pool-masters", "tower-arena", "precision", "four-in-a-row"],
  },

  {
    slug: "speed-typing",
    name: "Speed Typing",
    headline: "Speed Typing — Competitive Typing Game",
    category: "Racing",
    leaderboardKey: "speed-typing",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "A rated 1v1 typing race. Both players get the exact same passage on the same server clock, and the first to type it completely and correctly wins.",
    aiPractice: true,
    introduction: [
      "Speed Typing is a real-time 1v1 race over a single passage. The server picks the text, both seats receive exactly that text, and a synchronized countdown puts you both on the same clock.",
      "It is competitive because nothing is random during play and nothing is wagered — the result is a direct measurement of how quickly you can produce accurate text. Speed matters, but only correct characters count.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to be matched with a live opponent, or take a free practice race against the bot.",
      "The server selects one passage and gives the identical text to both players.",
      "A 3 → 2 → 1 → GO countdown runs from an absolute server instant, so neither player can gain anything from a slower connection.",
      "Type the passage. Your cursor position and your mistakes are verified against the server's own copy of the text.",
      "The first seat to submit the complete passage correctly wins immediately.",
    ],
    rules: [
      "Strictly 1v1. Two seats, one passage, no other format.",
      "The comparison is exact and positional: capitals, spacing and punctuation must all match, character for character.",
      "Line endings are the one exception — a CRLF from your browser is normalised so it cannot cost you a rated race.",
      "There is a hard limit of 120 seconds, measured from the server's GO instant.",
      "Nothing typed before GO counts, so a passage cannot be pre-loaded, and nothing after the deadline counts either.",
      "Backspace and correction are allowed and harmless. Progress and error counters only ever move forward, so fixing a letter never rewinds your position — but it also never erases the mistake from your record.",
      "Leaving a live race hands the win to your opponent.",
    ],
    scoring: [
      "The first seat to complete the whole passage correctly wins — one wrong character anywhere means 'not complete', so you must correct it to finish.",
      "If the clock runs out with nobody finished, the seat with more correctly typed characters wins. Mashing keys you never get right earns nothing, because the comparison is on correct characters only.",
      "Words per minute uses the standard five-characters-to-a-word convention over elapsed minutes, and it counts only correct characters.",
      "Accuracy is your correct characters divided by your typed characters, both derived from the server's own verification.",
      "Two finishes within 120 milliseconds of each other are treated as a dead heat and settled as a draw, so a result never turns on which packet arrived first.",
    ],
    strategy: [
      "Prize accuracy over raw speed. WPM counts correct characters only, so a fast typist with sloppy hands scores worse than a steady one.",
      "Do not stop mid-word to fix a letter if it breaks your rhythm — but do fix it. One wrong character anywhere blocks the finish entirely, so the correction is mandatory, not optional.",
      "Read a word ahead of your fingers. The passage does not scroll independently; the only thing setting your pace is how far ahead you can look.",
      "Keep a consistent rhythm through the whole passage. Racing is decided at the finish line, and the players who fade are the ones who sprinted the first line.",
      "Practise on varied text. The passage is chosen by the server, so raw typing ability on unfamiliar material transfers far better than memorising one paragraph.",
    ],
    competitive:
      "Speed Typing tests sustained typing speed and accuracy under a shared clock. Because both players race the identical text from the identical instant, the comparison is unusually direct — there is no luck to hide behind.",
    faq: [
      {
        q: "Do both players type the same text?",
        a: "Yes. The server selects one passage, and both seats receive exactly that text, starting from the same server-stamped GO instant.",
      },
      {
        q: "What happens if we both finish?",
        a: "The earlier verified finish wins. If the two finishes land within 120 milliseconds of each other, the race is recorded as a draw rather than being decided by packet arrival order.",
      },
      {
        q: "Do mistakes cost me points?",
        a: "They stop you finishing until you correct them, and they lower the accuracy you finish with. Your progress and error counters are monotonic, so correcting a letter never rewinds your position and never erases the mistake from the record.",
      },
      {
        q: "Can I practise before playing a ranked race?",
        a: "Yes. There is a free practice race against the bot, which is unrated and does not affect your Elo or trophies.",
      },
      {
        q: "Is it free?",
        a: "Yes. There is no wager, no token and no entry cost. Ranked results move your per-game Elo and your trophy ladder.",
      },
    ],
    related: ["solitaire-duel", "sudoku-duel", "keno", "precision"],
  },

  {
    slug: "tic-tac-toe",
    name: "Tic-Tac-Toe",
    headline: "Tic-Tac-Toe — 1v1 Duel with a Mega Twist",
    category: "Classic Strategy",
    leaderboardKey: "tic-tac-toe",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Rated 1v1 Tic-Tac-Toe where a draw does not end the match — it expands it. One board becomes four, then nine, until someone takes three in a row on the Mega grid.",
    aiPractice: true,
    introduction: [
      "This is Tic-Tac-Toe played as a rated 1v1 duel, with one crucial difference: a drawn board does not end the match. It expands it. A draw on the first board opens four more, and if those all resolve without a Mega line, the match grows to a full nine-board grid.",
      "It is competitive because plain Tic-Tac-Toe is a solved draw — the Mega expansion is what turns it back into a real contest, where board ORDER and the value of a drawn square become genuine decisions.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice game against the bot.",
      "Stage 1 is one ordinary 3×3 board. Player 1 plays X and always moves first; player 2 plays O.",
      "Players alternate turns, claiming one empty cell each.",
      "Complete a line of three — a row, a column or a diagonal — to win that board.",
      "If a board fills with no line, the match expands rather than ending. Stage 2 adds three more boards for four in total.",
      "When all four of stage 2's boards have resolved with no Mega line, the match expands to stage 3: the full nine-board grid.",
    ],
    rules: [
      "The board is 3×3 with 9 cells and 8 winning lines: three rows, three columns and two diagonals.",
      "Player 1 is X and moves first. Player 2 is O. Turns alternate strictly.",
      "The first player to complete one of the eight lines wins that board.",
      "A fully filled board with no line is a draw — and a draw is what triggers the Mega expansion.",
      "Boards sit on a fixed 3×3 lattice of slots. Stage 1 uses one slot, stage 2 uses four, and stage 3 uses all nine. An expansion only ever adds empty slots; it never moves or re-indexes a board that already exists.",
      "The Mega win needs three collinear controlled boards on that lattice. Stage 2 has only four slots, so it can never complete a Mega line — it always expands to stage 3 once its four boards have resolved.",
      "Nine boards is the maximum. There is deliberately no stage four.",
    ],
    scoring: [
      "Winning a single board is how you control a slot on the Mega lattice.",
      "Control three collinear slots — a row, a column or a diagonal of the lattice — to win the match.",
      "Because stage 2 cannot complete a Mega line by construction, it is a stepping stone: it decides which slots you enter stage 3 holding.",
      "A ranked result moves your per-game rating and your trophies for this game.",
    ],
    strategy: [
      "Play the centre. It belongs to four of the eight lines, more than any other cell, so it is the strongest first move on any single board.",
      "Then take a corner. A corner plus the centre is the classic fork: it creates two threats at once and there is no single reply that answers both.",
      "Block the fork, not the line. A player who only blocks the line they can see loses to the fork they cannot.",
      "Remember that a draw has value here. On the Mega lattice a drawn board is still a cell you contest — it can block a lattice line — so forcing a draw on a board your opponent needed to win is a real result.",
      "Think about slot positions, not just boards. Which lattice slots you win decides whether a Mega line is even available to you in stage 3, so where a board sits matters as much as who won it.",
      "Spend your attention on the boards that can complete a lattice line. On the nine-board grid, most boards are only relevant through the lattice slot they occupy.",
    ],
    competitive:
      "Tic-Tac-Toe tests forcing sequences and fork construction. The base game is a solved draw, so the Mega expansion is where the real planning lives — reading which lattice slots matter and playing each board to control them.",
    faq: [
      {
        q: "What is Mega Tic-Tac-Toe?",
        a: "The expansion mechanic. A drawn board does not end the match — it opens more boards on a fixed 3×3 lattice. Stage 1 is one board, stage 2 is four, and stage 3 is the full nine.",
      },
      {
        q: "How do you win the match?",
        a: "By controlling three collinear boards on the lattice — a row, a column or a diagonal. Winning individual boards is how you take those slots.",
      },
      {
        q: "Why can stage 2 never win outright?",
        a: "A Mega line needs three collinear boards, and stage 2 only has four lattice slots. So stage 2 always expands to stage 3 once all four of its boards have resolved.",
      },
      {
        q: "Who moves first?",
        a: "Player 1, who plays X. Turns alternate strictly from there.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered, and ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["four-in-a-row", "dots-and-boxes", "chess", "rps"],
  },

  {
    slug: "solitaire-duel",
    name: "Solitaire Duel",
    headline: "Solitaire Duel — Competitive Klondike Race",
    category: "Racing",
    leaderboardKey: "solitaire-duel",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "A rated 1v1 Klondike race. Both players get the exact same server-dealt puzzle and solve it simultaneously — first to put all 52 cards on the foundations wins.",
    aiPractice: true,
    introduction: [
      "Solitaire Duel turns Klondike into a head-to-head race. One deterministic deal is generated on the server and given to both players, who then play it at the same time on their own boards. The first to move all 52 cards onto the foundations wins.",
      "It is competitive because there is nothing random left once the match begins: the deal is identical for both seats, so the only difference between two players is how efficiently they read and sequence it.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Both players receive the exact same Klondike deal and play it simultaneously on their own board.",
      "Draw from the stock, build the tableau downward in alternating colours, and move cards up to the foundations in suit order from Ace.",
      "The first player to move all 52 cards onto the foundations wins immediately.",
      "If neither finishes before the match ends, the greater verified progress wins.",
    ],
    rules: [
      "The variant is Klondike with a single-card draw and unlimited redeals — chosen because it has by far the highest completion rate, so solving the puzzle is the normal ending rather than the exception.",
      "One deterministic deal per match, generated server-side from a committed seed. Both seats get that same deal on their own board.",
      "The server only serves a deal that a deterministic search has proved has a winning line, and that its engine can replay, and that a naive foundation-only strategy fails to solve — so every match is solvable, and never laid out for you.",
      "Foundations build upward per suit, starting at the Ace and ending at the King.",
      "The tableau builds downward in alternating colours, and only a King may be placed on an empty column.",
      "If neither seat finishes, the greater verified progress wins; an exact tie is a draw.",
      "Leaving or going inactive forfeits the match.",
    ],
    scoring: [
      "Putting all 52 cards on the foundations wins the match immediately.",
      "If nobody solves it before the match ends, the seat with the greater verified progress is the winner, and a level race is recorded as a draw.",
      "Progress is derived by the server from its own board state, never from a client's report.",
    ],
    strategy: [
      "Free the face-down cards. The concealed cards in the tableau are the real obstacle, so moves that expose one are worth more than moves that tidy the visible rows.",
      "Send aces and low cards up early. A foundation never blocks a tableau move, so every card you can promote is one less thing that can strand you later.",
      "Only empty a column when you have a King to put in it. An empty column is a resource, and wasting it is one of the most common ways to lose a race you were winning.",
      "Use the unlimited redeals deliberately. With a single-card draw you can cycle the stock as often as you need, so the stock is a resource for ordering your plays rather than a countdown.",
      "Because you both play the identical deal, efficiency beats creativity. The lines that solve this deal are the same for your opponent, so play the one you can execute fastest.",
      "Do not stop to admire the board. There is no score for elegance here — the only currency is cards on the foundations before your opponent gets there.",
    ],
    competitive:
      "Solitaire Duel tests card-reading and sequencing efficiency under a head-to-head clock. Both players face the same puzzle, so it is a straight measure of who can execute it faster.",
    faq: [
      {
        q: "Is the deal really the same for both players?",
        a: "Yes. One deterministic deal is generated server-side from the match seed, and both seats play it on their own board.",
      },
      {
        q: "Is every deal solvable?",
        a: "Yes. A deal is only served when a deterministic search has proved a winning line exists, the engine replays it, and a naive foundation-only strategy fails to solve it — so it is always winnable and never pre-solved.",
      },
      {
        q: "What happens if neither of us finishes?",
        a: "The player with the greater verified progress wins. If the race is exactly level, it is recorded as a draw.",
      },
      {
        q: "Which Klondike variant is it?",
        a: "Single-card draw with unlimited redeals. That variant has the highest completion rate, which keeps the 'first to solve it' win condition as the normal way a match ends.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered; ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["sudoku-duel", "speed-typing", "uno", "neon-flush"],
  },

  {
    slug: "sudoku-duel",
    name: "Sudoku Duel",
    headline: "Sudoku Duel — 1v1 Sudoku Race Online",
    category: "Puzzles",
    leaderboardKey: "sudoku-duel",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "A rated 1v1 Sudoku race. Both players receive the exact same server-generated 9×9 puzzle and solve it simultaneously — the first correct board wins.",
    aiPractice: true,
    introduction: [
      "Sudoku Duel takes the puzzle you already know and puts another player in the race. One 9×9 puzzle is generated by the server from a committed seed; both seats receive that exact puzzle on their own board and solve it at the same time.",
      "It is competitive because the puzzle is identical for both players and nothing is drawn during play. There is no opponent to read and no luck to blame — the result is your solving speed and accuracy against theirs.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Both players receive the exact same server-generated 9×9 puzzle on their own independent board.",
      "A 3 → 2 → 1 → GO countdown runs on a server clock before the first legal move — the window is pure planning time.",
      "Select a cell and place a digit from 1 to 9. Every placement is judged by the server against its own solution.",
      "Fill your board correctly and you win immediately.",
    ],
    rules: [
      "Standard 9×9 Sudoku: every row, every column and every 3×3 box must contain each of the digits 1 to 9 exactly once.",
      "The clue cells are fixed. A given cell can never be edited.",
      "A placement that would break a row, column or box constraint on the visible board is rejected.",
      "The puzzle is generated once, server-side, from one committed seed under a frozen ruleset — neither player can influence the other's board.",
      "Difficulty describes the puzzle, not an opponent. It is a clue-count target: around 46 clues on easy, 34 on normal and 26 on hard, with clues only ever removed while the puzzle keeps exactly one solution.",
      "There is no match clock. A match ends on completion, on a concession or long disconnect, or on inactivity — a seat that stops acting is alarmed at fifteen minutes and forfeits at twenty.",
      "Each seat is capped at a generous maximum number of accepted actions, so one player's scripted spam can never truncate the other's game.",
    ],
    scoring: [
      "The first seat to fill its board correctly wins the moment the final required cell lands.",
      "The winner is decided on ADJUSTED completion time: each incorrect placement adds a one-second penalty on top of when you actually finished.",
      "That penalty is what makes guess-and-check a losing strategy — a careless solver can finish first and still lose the race on time.",
      "If the match is ended by the inactivity path instead, the greater verified progress wins, then the fewest mistakes, then the earliest achievement of that progress.",
      "Progress, mistakes and the solution all live on the server; a client only ever names a cell and a value.",
    ],
    strategy: [
      "Use the countdown. Nothing is accepted before GO, so the three seconds are free planning time — scan the grid for the obvious singles before the clock starts.",
      "Take the naked singles first. A cell with only one possible digit is guaranteed progress and it costs you no thinking.",
      "Then work box by box. Restricting a candidate scan to a single 3×3 box is much faster than re-scanning rows and columns you have already cleared.",
      "Never guess. A wrong value costs a full second against an opponent who answered carefully, and it does not advance your progress at all.",
      "Track candidate pairs. Where two cells in a box can only hold the same two digits, you have eliminated those digits from the rest of that box.",
      "On a hard puzzle the clue count is low, so more of the solve depends on technique rather than speed. Play for correctness and let your opponent make the mistake.",
    ],
    competitive:
      "Sudoku Duel tests accuracy and pattern recognition under race pressure. Because the puzzle is identical for both players and the solution never leaves the server, the result measures solving ability and nothing else.",
    faq: [
      {
        q: "Is my opponent solving the same puzzle?",
        a: "Yes. One puzzle is generated server-side from a committed seed, and both seats solve that exact puzzle on their own independent board.",
      },
      {
        q: "Is there a time limit?",
        a: "There is no match clock. A match ends when someone completes the puzzle, on a concession or long disconnect, or on inactivity — a seat that stops acting is alarmed after fifteen minutes and forfeits after twenty.",
      },
      {
        q: "What happens if I enter a wrong number?",
        a: "The placement is rejected, your progress does not change, and it adds a one-second penalty to your competitive completion time.",
      },
      {
        q: "Can I edit a clue?",
        a: "No. Given cells are fixed for the whole match.",
      },
      {
        q: "What do the difficulty levels change?",
        a: "The clue count. Easy targets about 46 clues, normal about 34 and hard about 26 — and clues are only removed while the puzzle keeps exactly one solution.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered; ranked results move your per-game Elo and trophy ladder.",
      },
    ],
    related: ["solitaire-duel", "chess", "speed-typing", "memory-grid"],
  },

  {
    slug: "odds",
    name: "Odds",
    headline: "Odds — 1v1 Number Prediction Duel",
    category: "Mind Games",
    leaderboardKey: "odds",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Six rounds of hidden numbers. Lock in your own number, then predict your opponent's, while the range shrinks from 1–100 down to 1–3.",
    aiPractice: true,
    introduction: [
      "Odds is a prediction duel in six rounds. Each round has two simultaneous phases: you secretly choose your own number inside the round's range, and then you predict the number your opponent secretly chose. Both numbers and both predictions stay hidden until the round reveals.",
      "It is competitive because the ranges shrink on a fixed schedule while the scoring bands stay identical — so the game never gives you more points to win, it just takes away your room to be wrong.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Each round starts with a range: 1–100, then 1–50, 1–25, 1–12, 1–6, and finally 1–3.",
      "Phase 1 — pick your number: both players independently lock in a hidden number inside that range.",
      "Phase 2 — predict: once both numbers are locked, each player predicts the opponent's number inside the same range.",
      "Both predictions stay hidden until both are submitted. Then the round reveals both numbers, both predictions, and the points each prediction earned.",
      "After six rounds, the higher cumulative score wins.",
    ],
    rules: [
      "A match is six rounds. Every round is simultaneous — there are no turns and no roles.",
      "The range shrinks on a fixed schedule, purely halved and floored: round 1 is 1–100, round 2 is 1–50, round 3 is 1–25, round 4 is 1–12, round 5 is 1–6 and round 6 is 1–3.",
      "Your chosen number is never sent to your opponent while the round is live, and both predictions stay hidden until both players have committed.",
      "A prediction outside the round's range scores zero.",
      "After six rounds the higher cumulative score wins; an exact tie is a draw.",
    ],
    scoring: [
      "Scoring uses a fixed band table that is identical in every round: an exact match scores +100, off by 1 scores +80, off by 2 scores +60, off by 3 scores +40, off by 4–5 scores +20, off by 6–10 scores +10, and more than 10 off scores 0.",
      "A prediction can never earn more than +100.",
      "The shrinking range only bounds what counts as a valid prediction — it never changes the bands and never scales the points.",
      "The player with the higher cumulative score after six rounds wins the match.",
    ],
    strategy: [
      "Do not assume the range is the scoring curve. It is not — the bands are the same in round 1 and round 6, so a late round is worth exactly as much as an early one, just with far less room to miss.",
      "Avoid the obvious numbers when picking. People over-pick the mid-range and the culturally famous picks, and every player who guesses a number you also chose is a player you handed points to.",
      "Model your opponent, not the uniform distribution. If they have picked near the top of the range twice, the middle is where their next pick is least likely to be.",
      "Go for the exact match. Bands fall off fast: being off by 4 already caps you at +20, so splitting the difference is worth far less than committing to one number.",
      "Break your own pattern. In a shrinking range you will run out of numbers you have not used, and a player who notices your preference for one end of the range can price it in.",
      "Protect a lead by picking counter-intuitively. Late rounds are low-scoring for everyone, so an unusual number that nobody would predict is often worth more than a 'safe' one.",
    ],
    competitive:
      "Odds tests opponent modelling and decision-making with hidden information. You are trying to predict a decision another person made while protecting your own, and the shrinking range closes down your options every round.",
    faq: [
      {
        q: "Can my opponent see my number?",
        a: "No. Both chosen numbers and both predictions stay hidden until both players have submitted their predictions for the round.",
      },
      {
        q: "Does the shrinking range change the points?",
        a: "No. The band table is identical in every round. The range only limits what counts as a valid prediction.",
      },
      {
        q: "What is the range schedule?",
        a: "Round 1 is 1–100, then 1–50, 1–25, 1–12, 1–6, and 1–3 in the final round.",
      },
      {
        q: "What if the score is tied after six rounds?",
        a: "The match is recorded as a draw. No winner is invented.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. There is no wager and no entry cost; ranked results move your Elo and trophies.",
      },
    ],
    related: ["rps", "neon-flush", "dice-flush", "chess"],
  },

  {
    slug: "dice-flush",
    name: "Dice Flush",
    headline: "Dice Flush — 1v1 Dice & Scorecard Duel",
    category: "Dice",
    leaderboardKey: "yahtzee",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Yahtzee-style dice against a live opponent on one SHARED scorecard. A category either of you claims is closed to both, so blocking matters as much as scoring.",
    aiPractice: true,
    introduction: [
      "Dice Flush is a five-dice scoring duel with a single shared scorecard. You roll, hold the dice you want to keep, and then commit the result to a category — but every category you take is taken away from your opponent, and vice versa.",
      "It is competitive because the denial is as real as the scoring. Thirteen categories on one sheet between two players means the good ones run out fast, and the match is often decided by who claims what and when.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "On your turn you have five dice. Roll them, choose which to hold, and reroll the rest.",
      "When you are happy with the result — or out of rolls — commit it to an open category.",
      "Your opponent then takes their turn the same way.",
      "Play continues until the scorecard has no open categories left, and the higher total wins.",
    ],
    rules: [
      "Five dice per turn, with the standard roll-and-hold structure: you decide which dice to keep and reroll the rest.",
      "There is ONE shared scorecard. A category claimed by either player is closed to both, and the owner of each category is recorded.",
      "The categories are: ones, twos, threes, fours, fives, sixes, three of a kind, four of a kind, full house, small straight, large straight, and five of a kind.",
      "Each turn runs on a time limit, and a turn that runs out is auto-banked rather than left hanging.",
      "Because the sheet is shared, it fills twice as fast as a solo Yahtzee card — the match ends when the last category is claimed.",
    ],
    scoring: [
      "The six number categories score according to how many dice show that number.",
      "Three of a kind, four of a kind and five of a kind score from the dice that make up the set.",
      "Full house, small straight and large straight are pattern categories with their own fixed values.",
      "The player with the higher total across the whole shared sheet wins the match.",
      "Ranked results move your per-game rating and your trophy ladder for this game.",
    ],
    strategy: [
      "Claim the scarce categories first. A large straight or a five of a kind is hard to roll, and if you leave it open your opponent may simply take it — and you never get another chance at it.",
      "Use the number categories as your safety net. Ones and twos are easy to fill and free you to spend your turns chasing the big patterns.",
      "Block deliberately. Taking a category your opponent clearly needed is often worth more than the few points you score by taking it.",
      "Count what is left. Once few categories remain, your reroll decisions should be driven by which patterns are still claimable rather than by the current dice.",
      "Do not over-chase. Holding dice for a straight across three rerolls usually produces nothing, and the zero you bank on that turn is a real cost.",
      "Watch your turn timer. An expired turn is auto-banked with whatever your dice happen to show, which is a much worse outcome than committing deliberately.",
    ],
    competitive:
      "Dice Flush tests probability judgement and denial. The dice supply the variance, but on a shared sheet the outcome usually turns on which categories you claim and which you deny.",
    faq: [
      {
        q: "Do we each have our own scorecard?",
        a: "No — you share one. A category claimed by either player is closed to both, so the sheet fills twice as fast and denying a category is a real, permanent play.",
      },
      {
        q: "What happens if I run out of time on a turn?",
        a: "The turn is auto-banked: whatever your dice currently show is committed rather than the turn hanging. Committing deliberately is almost always better.",
      },
      {
        q: "Which categories are on the sheet?",
        a: "Ones through sixes, three of a kind, four of a kind, full house, small straight, large straight, and five of a kind.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered, and ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["odds", "rps", "neon-flush", "uno"],
  },

  {
    slug: "hex-duel",
    name: "Hex Duel",
    headline: "Hex Duel — 1v1 Hex Grid Conquest",
    category: "Classic Strategy",
    leaderboardKey: "hex-duel",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Hex-grid territory conquest. Capture tiles, grow troops and push your army across the board to take your opponent's capital — owning the most tiles is not enough.",
    aiPractice: true,
    introduction: [
      "Hex Duel is a turn-based conquest game on a hexagonal grid. Every tile can be held, every held tile carries troops, and the game is won by marching into your opponent's capital rather than by owning the most ground.",
      "It is competitive because territory cuts both ways: expanding wins you resources but stretches the army that has to defend the tile you lose the match for.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to face a live opponent, or take a free practice match against the bot.",
      "Each player starts with a capital tile. Capturing your opponent's capital wins the match outright.",
      "On your turn you spend a limited pool of action points. Capture neutral or enemy tiles to expand your territory.",
      "Troops accumulate on the tiles you hold, so a stack you leave alone gets stronger over time.",
      "Attack when you can field more troops than the defender; reinforce to build a stack up before a push.",
      "Push toward the enemy capital — that, and only that, ends the match.",
    ],
    rules: [
      "Strictly 1v1 on a hexagonal grid, with players alternating turns.",
      "Each turn gives the current player a limited pool of action points. Every action costs some of that pool, and the turn ends when you choose to end it or run out.",
      "The available actions are movement, attack, push, reinforce, displacement and end turn.",
      "Tiles can be captured and owned by a player, and ownership is tracked per tile. Each owned tile holds a count of troops.",
      "Troops grow over time on the tiles their owner holds.",
      "Each player has exactly one capital tile, fixed at the start of the match.",
    ],
    scoring: [
      "You win by conquering the enemy capital: if you own your opponent's capital tile, the match is yours.",
      "Owning more tiles does not win the match — territory is a means to reach the capital, not a score.",
      "Territory and troop counts are tracked per player for display, but the capital is the win condition.",
      "A ranked result moves your per-game rating and your trophies for this game.",
    ],
    strategy: [
      "Never lose sight of your own capital. It is the only tile whose loss ends the match, so a territorial lead that leaves your capital thin is not a lead at all.",
      "Mass before you attack. An attack that does not clearly outnumber the defender usually just trades troops and hands back the initiative.",
      "Reinforce your front, not your back. Troops far from the fighting defend nothing, and your action points are a finite resource every turn.",
      "Expand toward your opponent, not away from them. Capturing neutral ground in the wrong direction grows your territory and your problem at the same time.",
      "Mind your action-point budget. Every turn you must choose between capturing, attacking and reinforcing, and can only do some of them — so decide the turn's objective before you spend the first point.",
      "Watch troop growth. A stack left alone quietly becomes an army, so a tile your opponent has been ignoring is worth checking before you commit to a push elsewhere.",
    ],
    competitive:
      "Hex Duel tests territorial planning and army sizing. It is a resource-allocation game: action points each turn, troops over time, and one capture that actually wins.",
    faq: [
      {
        q: "How do I win?",
        a: "By conquering your opponent's capital tile. Holding more territory than your opponent does not win the match on its own.",
      },
      {
        q: "Do troops get stronger over time?",
        a: "Yes. Troops grow on the tiles their owner holds, so a stack you leave alone gets stronger — and so does one your opponent leaves alone.",
      },
      {
        q: "Is there a multi-player hex mode?",
        a: "No. Hex Duel is strictly a 1v1 duel — two seats, alternating turns.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered; ranked results move your Elo and trophies for this game.",
      },
    ],
    related: ["chess", "dots-and-boxes", "four-in-a-row", "tower-arena"],
  },

  {
    slug: "uno",
    name: "UNO",
    headline: "UNO — 1v1 Card Duel Online",
    category: "Card Games",
    leaderboardKey: "uno",
    ogImage: "/images/og-banner.png",
    shortDescription:
      "Classic UNO against a live opponent or the bot. Match the colour in force or the top card's value, spend your wilds wisely, and be first to empty your hand.",
    aiPractice: true,
    introduction: [
      "UNO on GRYND is a two-player shedding duel with the full card set: numbers, Skip, Reverse, Draw Two, Wild and Wild Draw Four. The objective is the familiar one — be first to get rid of every card in your hand.",
      "It is competitive because the colour in force is a decision rather than a fact. A well-timed wild can leave an opponent holding a hand they cannot play, and that is where matches are won.",
    ],
    howToPlay: [
      "Sign in, open the lobby and press Play to be matched with another player, or take a free practice game against the bot.",
      "On your turn, play a card that matches either the colour currently in force or the value of the top card of the discard pile.",
      "If nothing in your hand is playable, draw from the deck.",
      "Wild cards let you declare a new colour, and the declared colour — not the card's printed colour — is what the next player must match.",
      "Empty your hand and the game is yours.",
    ],
    rules: [
      "A card is playable if it matches the colour currently in force or the value of the top card of the discard pile.",
      "A Wild card is always playable.",
      "A Wild Draw Four is only legal when you hold no card that matches the colour currently in force. This restriction is enforced rather than optional.",
      "When the top card is a wild, only colour-matching cards are playable — value matching is meaningless, because a wild carries no number.",
      "After a wild is played, the colour in force is the colour the player declared.",
      "The deck and both hands are managed server-side, so the client only ever sees what the server says is in the hand.",
    ],
    scoring: [
      "The first player to empty their hand wins — there is no point accumulation.",
      "A ranked result moves your per-game rating and your trophy ladder for this game.",
    ],
    strategy: [
      "Save your wilds for when you are actually stuck. A wild spent early hands your opponent a colour they can work with; a wild spent late is frequently the card that finishes the game.",
      "Pick your declared colour from your own hand, not from the board. Declaring the colour you hold most of is what keeps a run of plays going.",
      "Use Draw Two and Wild Draw Four as tempo plays. Making your opponent draw is both a delay and more cards they must shed before they can win.",
      "Keep your hand spread across colours. A hand with four colours survives any declaration; a hand stacked in one colour dies to a single well-timed wild.",
      "Track which colours are running thin in the discard pile. A colour that is nearly exhausted is usually a safe declaration, and the cards you hold in it become dead weight for your opponent.",
      "Avoid being the predictable one. If you always declare the same colour, an observant opponent will plan around it — mix in a declaration that cuts off the hand you expect them to hold.",
    ],
    competitive:
      "UNO tests hand management and colour planning against a real opponent. The rules take a minute to learn; deciding when a wild is worth spending is a skill you keep improving at.",
    faq: [
      {
        q: "Can I play a Wild Draw Four at any time?",
        a: "No. It is only legal when you hold no card matching the colour currently in force. The rule is enforced, so the card simply will not be playable otherwise.",
      },
      {
        q: "What decides which cards I can play?",
        a: "The colour currently in force and the value of the top card of the discard pile. Once a wild has been played, only the declared colour matters.",
      },
      {
        q: "Does UNO have its own Elo?",
        a: "Yes. Ratings are per-game and independent, so your UNO results move this game's ladder and no other.",
      },
      {
        q: "Is it free to play?",
        a: "Yes. Nothing is wagered, and there is no entry cost of any kind.",
      },
    ],
    related: ["neon-flush", "solitaire-duel", "dice-flush", "odds"],
  },
];

/** Slugs that have a public landing page, in catalog order. */
export const GAME_LANDING_SLUGS: readonly string[] = GAME_LANDING_PAGES.map((g) => g.slug);

/** slug → entry. */
export const GAME_LANDING_BY_SLUG: Readonly<Record<string, GameLandingPage>> = Object.fromEntries(
  GAME_LANDING_PAGES.map((game) => [game.slug, game]),
);

/** The public landing-page path for a slug. */
export function gameLandingPath(slug: string): string {
  return `/games/${slug}`;
}

/**
 * The AUTHENTICATED gameplay path for a slug.
 *
 * `/games/<slug>/play` is rewritten (next.config.js) to the existing
 * `/casino/<slug>` lobby, so the Play CTA leads into the unchanged Clerk-
 * protected game application: same clients, same matchmaking, same APIs.
 */
export function gamePlayPath(slug: string): string {
  return `/games/${slug}/play`;
}

/** True when a slug has a public landing page. */
export function isGameLandingSlug(slug: unknown): boolean {
  return typeof slug === "string" && Object.hasOwn(GAME_LANDING_BY_SLUG, slug);
}

/** The landing-page URL for a slug, on the canonical origin. */
export function gameLandingUrl(slug: string): string {
  return `${SITE_ORIGIN}${gameLandingPath(slug)}`;
}

/** Resolve a slug's related games to their catalog entries. */
export function relatedGames(slug: string): GameLandingPage[] {
  const game = GAME_LANDING_BY_SLUG[slug];
  if (!game) return [];
  return game.related
    .map((relatedSlug) => GAME_LANDING_BY_SLUG[relatedSlug])
    .filter((entry): entry is GameLandingPage => Boolean(entry));
}

/**
 * ── Crawlable link projections ────────────────────────────────────────────
 *
 * The catalogue above is the single source of truth for which public game
 * pages exist. The homepage, the /games hub and the help pages all need to
 * LINK to those pages, and they are all client components — importing the
 * catalogue from a `"use client"` module would ship 1,500 lines of game prose
 * to every visitor's browser to render a few anchors.
 *
 * So the surfaces that render game links take a minimal `{ slug, name }`
 * projection instead, built HERE, on the server, and passed down as props
 * (the same shape Next serialises across the server/client boundary). One
 * `GAME_INDEX` derivation means the links cannot drift from the pages, and a
 * game added to the catalogue shows up in every crawlable list without anyone
 * remembering to add it.
 */

/** The minimal shape a crawlable game link needs. */
export type GameIndexEntry = {
  slug: string;
  name: string;
};

/** Every public game, A–Z by display name. */
export const GAME_INDEX: readonly GameIndexEntry[] = [...GAME_LANDING_PAGES]
  .map(({ slug, name }) => ({ slug, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Resolve slugs to index entries, A–Z, dropping any unknown slug.
 *
 * Ordering is deliberate: these lists are read by a crawler as much as by a
 * visitor, and a stable order keeps the rendered HTML from churning between
 * deploys (which would look like the links moved).
 */
export function gameIndexFor(slugs: readonly string[]): GameIndexEntry[] {
  return slugs
    .map((slug) => GAME_LANDING_BY_SLUG[slug])
    .filter((entry): entry is GameLandingPage => Boolean(entry))
    .map(({ slug, name }) => ({ slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The games the HOME page links to by name.
 *
 * These are the hub catalogue's own `popular: true` entries
 * (src/app/casino/PageClient.jsx) — the site's existing popularity signal, not
 * a second opinion invented here. tests/internal-linking.test.mjs asserts the
 * two stay equal, so this list cannot quietly become a different claim about
 * which games are popular.
 */
export const HOMEPAGE_FEATURED_SLUGS: readonly string[] = [
  "mines-pvp",
  "memory-grid",
  "dice-flush",
  "odds",
];

/**
 * The games the help/FAQ page links to by name.
 *
 * Chosen to answer the question each one is put next to: the FAQ's "skill or
 * luck?" and "AI or PvP?" entries are about exactly these five — a classic
 * strategy game, a pure-reflex game, a memory game, a game with a real chance
 * element, and the shortest match on the site.
 */
export const HELP_FEATURED_SLUGS: readonly string[] = [
  "chess",
  "speed-typing",
  "memory-grid",
  "mines-pvp",
  "rps",
];
