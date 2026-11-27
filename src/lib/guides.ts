// src/lib/guides.ts
//
// THE GUIDES LIBRARY — a small set of original articles about the one game
// GRYND offers: Klondike Solitaire, played head to head.
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// The public pages explain WHAT the game is (src/lib/gameLandingPages.ts) and
// the Academy teaches the rules interactively. This module is the editorial
// layer: a dozen articles about the decisions that actually decide a Solitaire
// deal — reveals, promotion, stock order, tempo — and about the habits that
// make a competitive player better.
//
// ── The rules every guide here follows ────────────────────────────────────
//
//   * NO SPAM. Thirteen guides, not thirteen hundred. Each answers a question a
//     real player has, and the set is closed until there is a genuinely new
//     question to answer.
//   * NO FAKE AUTHORITY. There are no invented authors, review counts or
//     statistics. Where a number appears it is a mechanical fact of Klondike or
//     of Solitaire Duel, taken from the game's own server-side source.
//   * NO KEYWORD STUFFING and no duplicated paragraphs. Two guides may both
//     mention the stock or an empty column because both genuinely concern it;
//     they never make the same point about it.
//   * NO INVENTED MECHANICS. Every GRYND-specific claim points at something the
//     game does today: one deterministic deal served to both seats, a
//     solver-verified winning line, verified progress as the tiebreak, free
//     ranked play that moves Elo and trophies. tests/guides.test.mjs asserts
//     every guide is reachable, indexable and links only to real pages.
//
// ── Structure ─────────────────────────────────────────────────────────────
//
// Guides are DATA, rendered by one server component
// (src/components/guides/GuideArticle.tsx) so no page duplicates JSX and the
// whole article is in the HTML response with no JavaScript required.

import { CANONICAL_SITE_URL } from "./siteUrl";

/**
 * The canonical origin the public site is served from — www, the host the
 * platform serves (the apex 308-redirects to it). Re-exported from the single
 * place that decides it (src/lib/siteUrl.ts).
 */
export const SITE_ORIGIN = CANONICAL_SITE_URL;

/** One titled block inside a guide: prose, a checklist, or both. */
export type GuideSection = {
  /** The section's H2. */
  heading: string;
  /** Body paragraphs, in order. */
  paragraphs?: string[];
  /** An optional short list rendered after the paragraphs. */
  bullets?: string[];
};

/** A public guide. */
export type Guide = {
  /** The `/guides/<slug>` path segment. */
  slug: string;
  /** The document title and the index-card heading. */
  title: string;
  /** The meta description — unique per guide, never a template. */
  metaDescription: string;
  /** The on-page H1. */
  h1: string;
  /** One-paragraph framing shown under the H1. */
  summary: string;
  /** The article body. */
  sections: GuideSection[];
  /**
   * Slugs of the public game pages this guide makes relevant. Every entry is
   * a real `/games/<slug>` page; tests/guides.test.mjs asserts it.
   */
  gameSlugs: string[];
  /** Slugs of other guides worth reading next. */
  relatedGuides: string[];
};

export const GUIDES: readonly Guide[] = [
  {
    slug: "how-to-play-klondike-solitaire",
    title: "How to Play Klondike Solitaire: Rules and Setup",
    metaDescription:
      "A complete beginner's walkthrough of Klondike Solitaire: the deal, the seven tableau columns, the stock and waste, the four foundations, and the rules a GRYND duel enforces.",
    h1: "How to play Klondike Solitaire",
    summary:
      "Klondike has a reputation for being self-explanatory, and almost every new player gets one rule wrong: the empty column. This walkthrough covers the deal, the tableau, the foundations, the stock, and exactly how a competitive Solitaire Duel differs from the game you play alone.",
    sections: [
      {
        heading: "The deal: seven columns and a stock",
        paragraphs: [
          "Klondike is played with one standard 52-card deck. The deal builds seven tableau columns from left to right: the first column gets one card, the second two, and so on to seven, for twenty-eight cards in total. In each column only the top card is face up; the rest stay face down until the cards above them are moved away.",
          "The twenty-four cards left over become the stock, which sits face down at the top left of the board. You turn them over one at a time into the waste beside it. GRYND uses the single-card draw with unlimited redeals, so when the stock runs out you turn the waste back over and go through it again.",
        ],
      },
      {
        heading: "The foundations: one pile per suit",
        paragraphs: [
          "Above the tableau are four empty foundations. Each one takes a single suit, and each must be built upward from the ace to the king. An ace is the only card that can start a foundation, which is why finding the aces early matters more than almost anything else on the board.",
          "A foundation never blocks a move. A card that has gone up can still come back down if you need it in the tableau, so promoting a card is not a commitment — it is one less card in the way. The game ends the moment all fifty-two cards sit on the foundations.",
        ],
      },
      {
        heading: "Building down the tableau, in alternating colours",
        paragraphs: [
          "The tableau builds downward: a card may be placed on another card of the opposite colour and exactly one rank higher. A red six goes on a black seven, a black five on a red six, and so on. Any face-up card carries the sequence below it, so moving one card can uncover several cards at once.",
          "An empty column is the exception. Only a king may be placed there. That single rule is why emptying a column without a king in hand can leave you worse off than before, and why experienced players treat an empty column as a resource to spend deliberately.",
        ],
      },
      {
        heading: "Turning cards over is the real objective",
        paragraphs: [
          "Every face-down card is information you do not have. The point of most tableau moves is not to tidy the board but to expose the next hidden card, because each reveal adds a card you can use and a new option you did not have before.",
          "That is why a move which reveals a card usually beats a move that merely looks neater. When two plays are both legal and neither promotes anything, choose the one that turns something over. If neither does, cycle the stock and look for a better option.",
        ],
      },
      {
        heading: "How a GRYND duel differs from solitaire alone",
        paragraphs: [
          "In Solitaire Duel both seats receive the exact same deterministic deal from the server and play it at the same time on their own boards. The rules above are unchanged; the difference is that someone else is solving the same puzzle, and the first player to move all fifty-two cards onto the foundations wins.",
          "The server only serves a deal it has proved has a winning line, so a loss is never the deck's fault. If neither player finishes, the greater verified progress wins, and an exact tie is recorded as a draw. Ranked play is free and moves an Elo rating and trophies, not a pot.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["solitaire-strategy-for-beginners", "solitaire-mistakes-to-avoid"],
  },

  {
    slug: "solitaire-strategy-for-beginners",
    title: "Solitaire Strategy for Beginners: Priorities That Win Deals",
    metaDescription:
      "The move-order priorities that decide most Klondike deals: uncovering hidden cards, promoting aces, spending empty columns deliberately, and using the stock as a tool rather than an escape.",
    h1: "Solitaire strategy for beginners",
    summary:
      "Beginners lose more Klondike games to the order of their moves than to the deal. This guide sets out the priorities that matter: reveal before you tidy, promote whenever it is free, spend an empty column only for a king that does work, and treat the stock as a tool rather than an escape hatch.",
    sections: [
      {
        heading: "Uncover hidden cards before you tidy",
        paragraphs: [
          "A face-down card is the only thing on the board that can add a new option. A face-up card can always be moved later, but a hidden card cannot be used until it is revealed. When two moves are both legal, prefer the one that opens a new card, even if it leaves the columns looking uneven.",
          "This one habit separates beginners from players who finish deals. It is tempting to build a beautiful descending sequence in the middle of the board, but a sequence that reveals nothing has spent moves without buying information.",
        ],
      },
      {
        heading: "Promote aces and low cards immediately",
        paragraphs: [
          "An ace on a foundation is a card that can never block you. The same is true of every low card you can send up safely: once it is on the foundation, the tableau has one fewer rank to work around. Promote whenever the move is legal and does not cost you a reveal.",
          "The habit to avoid is holding a low card in the tableau because it fits somewhere. Fitting somewhere is not a reason to keep it; the foundation is where it belongs, and you can always bring it back down if a later move needs it.",
        ],
      },
      {
        heading: "Spend an empty column on a king you actually need to place",
        paragraphs: [
          "An empty column is flexible space, and the only card that can occupy it is a king. Do not fill it just because a king is available. Ask what placing that king lets you do: which hidden card it exposes, which sequence it unlocks, or which other column it frees.",
          "Sometimes the right move is to leave the column empty for two or three turns while you wait for a king that does more work. That feels wasteful and is usually correct. An empty column you fill too early is a resource you cannot get back.",
        ],
      },
      {
        heading: "Use the stock to reorder, not to escape",
        paragraphs: [
          "With a single-card draw and unlimited redeals, the stock is not a countdown; it is a way to change which card is available. Going through it once can rearrange the waste into an order that unlocks a tableau play you could not make before.",
          "The mistake is cycling the stock whenever the board looks stuck. Before you touch it, check whether a tableau move exists that you have overlooked. A stock cycle buys time, but it does not reveal anything new until you use the cards it gives you.",
        ],
      },
      {
        heading: "Think in two-move pairs",
        paragraphs: [
          "Strong players rarely evaluate a move on its own. They ask what the move makes possible next, and whether the follow-up depends on a card they cannot reach. A move that sets up a reveal next turn is worth more than one that merely looks safe.",
          "In a GRYND duel this matters even more, because the clock rewards the player who needs fewer moves for the same reveal. Efficiency is not about moving faster; it is about choosing a route that does not double back.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["how-to-play-klondike-solitaire", "how-to-win-solitaire-more-often"],
  },

  {
    slug: "how-to-win-solitaire-more-often",
    title: "How to Win Solitaire More Often",
    metaDescription:
      "Why winnable deals are not easy deals, how to recognise a dead board early, which moves are irreversible, and the review habit that turns a lost Klondike deal into a lesson.",
    h1: "How to win Solitaire more often",
    summary:
      "Winning more Klondike games is less about finding clever moves and more about recognising which deals are worth finishing. This guide covers what solvability really guarantees, how to spot a dead board early, and the review habit that turns a losing deal into a lesson.",
    sections: [
      {
        heading: "Winnable does not mean easy",
        paragraphs: [
          "Every deal served in Solitaire Duel has been proved to have a winning line before either player sees it. That guarantee is about existence, not difficulty: the line can be narrow, and a plausible-looking move can close it for good.",
          "So the question is never whether the deal can be won in theory. It is whether you can still find the line from the position you are in. Players who assume a lost-looking board is unwinnable give up on deals that were still recoverable.",
        ],
      },
      {
        heading: "Recognise a dead board early",
        paragraphs: [
          "A board is effectively dead when the cards you need are buried under cards you cannot move, and the stock has no useful order left. The signs are concrete: no legal tableau move, no king for an empty column, and a stock cycle that returns the same waste.",
          "Recognising that state early is not pessimism; it saves the moves you would spend on a position that cannot improve. In ranked play, switching from trying to win to protecting progress is sometimes the correct decision.",
        ],
      },
      {
        heading: "Prefer moves that cannot be undone",
        paragraphs: [
          "Promoting a card to a foundation is permanent progress. Revealing a hidden card is permanent information. Moving a sequence around the tableau is reversible and often worth nothing. When you have a choice, spend the move on the irreversible kind.",
          "This is the practical version of playing efficiently. Two players can make the same number of moves, but the one who spent them on foundations and reveals will be ahead on the board that matters.",
        ],
      },
      {
        heading: "Count what the stock still owes you",
        paragraphs: [
          "The stock is not infinite, even with unlimited redeals. It is a fixed set of twenty-four cards, and every cycle costs time. If the card you need is already visible in the waste or the tableau, another cycle cannot produce it.",
          "Counting is not about memorising the whole deck. It is about knowing whether the card you are waiting for has already passed. That single check prevents the most common waste of a close race.",
        ],
      },
      {
        heading: "Review the deal you lost",
        paragraphs: [
          "After a loss, find the first move you would change, not the last. The earliest mistake is usually the cause; the final move is only where it became visible. One sentence about that move is a better use of two minutes than another queue.",
          "Over a week, those sentences repeat. When one repeats three times it is a habit, not bad luck, and it becomes the thing to practise in an unrated mode before you take it back into ranked play.",
        ],
      },
      {
        heading: "Use the daily deal as a free lesson",
        paragraphs: [
          "The daily challenge gives every player the same deal once per UTC day, which makes it an unusually clean piece of practice. You can compare your route with the day's board rather than guessing whether a different decision would have helped.",
          "Play it slowly on purpose: no clock, no opponent, just the position. Then note the move that unlocked the deal. That note is more useful than another ranked match, because the same shape recurs.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["solitaire-memory-techniques", "speed-versus-accuracy-in-solitaire"],
  },

  {
    slug: "solitaire-mistakes-to-avoid",
    title: "Common Solitaire Mistakes (and What to Do Instead)",
    metaDescription:
      "The five Klondike habits that cost the most moves: filling empty columns too early, cycling the stock without purpose, building sequences for show, hoarding low cards and restarting unread deals.",
    h1: "Common Solitaire mistakes to avoid",
    summary:
      "Most Klondike losses come from a small set of habits that feel productive and are not. Here are the five that cost the most moves, why each one feels right at the time, and the simpler play to make instead.",
    sections: [
      {
        heading: "Filling an empty column because you can",
        paragraphs: [
          "An empty column is the most valuable space on the board, and a king is the only thing that can occupy it. Placing a king there immediately is often a mistake: you have spent your flexibility on the first king you found rather than the one that unlocks the most.",
          "Instead, ask what the king exposes. If it frees a hidden card or completes a run you need, place it. If it merely puts a card somewhere legal, leave the column empty and keep looking.",
        ],
      },
      {
        heading: "Cycling the stock before the tableau is exhausted",
        paragraphs: [
          "The stock feels like progress because the cards change. But a cycle that produces no new legal move has only spent time. Before you draw, scan every column for a move you have not made, including one that looks like it breaks a tidy sequence.",
          "A good rule is to exhaust the tableau first and cycle second. When you do cycle, cycle with a purpose: you are looking for a specific rank or colour that unlocks a specific column, not simply hoping the next card is better.",
        ],
      },
      {
        heading: "Building a long sequence for its own sake",
        paragraphs: [
          "A long alternating sequence looks like achievement, but if every card in it is already face up, the sequence has revealed nothing. It may even hide the fact that a shorter, messier arrangement would expose more.",
          "Judge a sequence by what it makes reachable. If collapsing it lets you promote a card or turn over a hidden one, the tidy version was costing you moves.",
        ],
      },
      {
        heading: "Holding a low card because it fits",
        paragraphs: [
          "A low card that fits into a tableau sequence is not therefore doing useful work. If the card can go to its foundation, sending it there removes a rank from the tableau and cannot block a future move.",
          "Keep a low card in play only when it is actively holding a sequence together or covering nothing useful. The default should be to promote.",
        ],
      },
      {
        heading: "Restarting a deal you have not read",
        paragraphs: [
          "A deal that looks bad after ten moves may still have a narrow line. Restarting is cheap in solo play and expensive in a race, because the clock keeps running while you decide.",
          "Read the board first: what is buried, what the stock still holds, and whether any column can be opened. If the answer is genuinely nothing, restart or protect progress. If it is unclear, keep playing and find out.",
        ],
      },
      {
        heading: "Mistake: assuming a legal move is a good move",
        paragraphs: [
          "Almost every card on the board is legal somewhere, which makes legality a poor test of a move. The question is not whether you can place a card but whether placing it improves the position you will face three moves from now.",
          "Before you commit, name what the move changes: a reveal, a foundation, an open column, or nothing. When the answer is nothing, the move is a candidate to skip, even though the rules allow it.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["solitaire-strategy-for-beginners", "how-to-play-klondike-solitaire"],
  },

  {
    slug: "solitaire-memory-techniques",
    title: "Solitaire Memory Techniques: Track the Cards That Matter",
    metaDescription:
      "How to remember what matters in Klondike without memorising the deck: tracking ranks by colour, reading the foundations, reconstructing the stock and rehearsing recall without a clock.",
    h1: "Solitaire memory techniques",
    summary:
      "You do not need a photographic memory to play Klondike well. You need to track a handful of facts about what has been played, what is still buried, and what the stock can still deliver. This guide shows how to hold those facts without straining.",
    sections: [
      {
        heading: "You do not need all fifty-two cards",
        paragraphs: [
          "Memory in solitaire is not a card-by-card inventory. Most of the deck is visible, either on the tableau or on the foundations, so the useful question is much smaller: which ranks are still missing, and where could they be?",
          "That is a handful of facts, not fifty-two. Players who try to hold the whole deck exhaust themselves; players who track the few missing ranks stay sharp through a long session.",
        ],
      },
      {
        heading: "Track ranks by colour, not by suit",
        paragraphs: [
          "For tableau building you need to know whether a red or black card of a given rank is available, not which of the two suits it belongs to. Tracking colour and rank is half the information and almost all of the usefulness.",
          "Suits only become decisive on the foundations. Until a suit is close to complete, colour is the better filter, and it is far easier to keep in mind under a clock.",
        ],
      },
      {
        heading: "Use the foundations as a scoreboard",
        paragraphs: [
          "The foundations tell you what has left the deck. If the three of hearts is on its foundation, it cannot be in the stock, and it cannot be blocking a column. Reading the foundations first is a free memory aid that costs no effort.",
          "Before each cycle of the stock, glance at the four piles and note which ranks are already gone. What remains is the short list worth remembering.",
        ],
      },
      {
        heading: "Reconstruct the stock from what is missing",
        paragraphs: [
          "The stock and the waste together hold the cards that are not on the tableau or the foundations. When you need a specific card, work out where it can possibly be before you draw. If it is already visible, no amount of cycling will produce it.",
          "This is the most practical memory skill in the game. It prevents wasted cycles and it tells you when a deal is genuinely stuck rather than merely awkward.",
        ],
      },
      {
        heading: "Rehearse recall in solo games",
        paragraphs: [
          "Solo Klondike is the right place to train memory because there is no clock pressure and no opponent. Pause before each draw and name the card you are hoping for, then check whether that hope was realistic.",
          "Do that for a few games and the tracking becomes automatic. The skill transfers directly to Solitaire Duel, where the same recall happens under a clock.",
        ],
      },
      {
        heading: "Name the card before you draw",
        paragraphs: [
          "A small habit makes tracking concrete: before every draw, say which card would help most and where it could be. Then draw and check. If the card was impossible, you have learned something about the stock without spending a cycle.",
          "This turns a vague sense of the board into a testable prediction. It is also the fastest way to notice that a deal is stuck, because you run out of useful cards to name long before you run out of stock.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["how-to-win-solitaire-more-often", "how-to-concentrate-on-solitaire"],
  },

  {
    slug: "how-solitaire-duel-scoring-works",
    title: "How Solitaire Duel Scoring Works",
    metaDescription:
      "Exactly how a Solitaire Duel match is decided: the fifty-two-card win, verified progress as the tiebreak, what progress measures, why an exact tie is a draw, and what a result changes.",
    h1: "How Solitaire Duel scoring works",
    summary:
      "A Solitaire Duel match can end in a clean win, a progress win or a draw. This guide explains exactly what the server measures, why the progress tiebreak exists, and what a result does and does not change on your account.",
    sections: [
      {
        heading: "The clean ending: all fifty-two on the foundations",
        paragraphs: [
          "The primary win condition is the one Klondike has always had: move all fifty-two cards onto the four foundations. The first player to do it wins immediately, and the match ends for both seats.",
          "Because both players receive the same deterministic deal, this is a pure race. There is no hidden luck after the deal, and no way for one seat to have a better starting board than the other.",
        ],
      },
      {
        heading: "The clock ending: verified progress",
        paragraphs: [
          "If neither player finishes before the match ends, the winner is the seat with the greater verified progress. Progress is derived by the server from its own board state, never from a client report, so a player cannot claim a lead they do not have.",
          "That means the trailing seat still has a reason to keep playing. Abandoning a board that cannot be finished can turn a narrow progress loss into a much larger one.",
        ],
      },
      {
        heading: "What progress measures",
        paragraphs: [
          "Progress reflects how much of the deal you have actually advanced: the cards moved onto the foundations and the board state that follows from them. It is not a score for effort, and it is not a count of moves made.",
          "The practical consequence is that a fast but shallow game can lose to a slower, deeper one. Promote cards, reveal hidden ones, and treat every irreversible move as progress the server can see.",
        ],
      },
      {
        heading: "Why an exact tie is a draw",
        paragraphs: [
          "If the two seats finish level, the match is recorded as a draw. A draw is a real result: it is not a win for either player, and it does not pretend that one seat was better.",
          "That is the honest outcome when the same deal produces the same progress. Inventing a tiebreaker the game does not measure would make the rating less meaningful, not more.",
        ],
      },
      {
        heading: "What a result changes",
        paragraphs: [
          "A completed ranked match moves your per-game Elo rating and your trophy ladder. Nothing is wagered, there is no entry fee, and no purchase can influence the result.",
          "Solo, daily and practice modes are deliberately separate. They build skill and habits, but they do not change your ranked rating, which keeps the ladder a measure of competitive results rather than volume.",
        ],
      },
      {
        heading: "How the match timer shapes a response",
        paragraphs: [
          "The timer is part of the scoring system, not a separate feature. It decides whether the clean ending is reachable at all, and therefore whether the correct plan is to finish or to bank progress.",
          "That is why a match can be won without finishing the deal. Treat the clock as information: if there is time for the full line, play it; if there is not, take the irreversible progress in front of you instead of a speculative detour.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["speed-versus-accuracy-in-solitaire", "is-solitaire-a-skill-game"],
  },

  {
    slug: "speed-versus-accuracy-in-solitaire",
    title: "Speed vs Accuracy in Solitaire",
    metaDescription:
      "When to move fast in a Solitaire race and when to pause: the true cost of a correction, which moves are risk-free, and how to pick a tempo from the deal instead of your nerves.",
    h1: "Speed vs accuracy in Solitaire",
    summary:
      "In a Solitaire race, speed and accuracy are not opposites. The fastest line is usually the one with the fewest corrections, and the players who look calm are often the ones who decided their route before the clock started to matter.",
    sections: [
      {
        heading: "A wrong move is a time penalty you pay twice",
        paragraphs: [
          "A move that has to be undone costs the time to make it and the time to reverse it. In a race with a shared clock that is a double loss, and it usually arrives at the worst moment: late in the deal, when the board is tight.",
          "That is why accuracy is not a conservative strategy. Avoiding one correction often buys more time than rushing three extra moves.",
        ],
      },
      {
        heading: "Where playing fast costs nothing",
        paragraphs: [
          "Some moves carry no risk at all. Promoting a card to a foundation, turning over a hidden card, or placing a king in a column you deliberately emptied are all unambiguous. There is no reason to deliberate over them.",
          "The skill is recognising which decisions are free. Spend your thinking on the moves that close options, and execute the obvious ones immediately.",
        ],
      },
      {
        heading: "Where one extra second saves the race",
        paragraphs: [
          "The expensive decisions are the ones that empty a column, bury a needed card, or commit the stock to a particular order. Those deserve a pause, because a mistake there can cost the rest of the deal.",
          "A useful habit is to name the cost before you move: what does this make unreachable? If the answer is nothing, move. If it is a card you still need, look for another route.",
        ],
      },
      {
        heading: "Read the clock, not your nerves",
        paragraphs: [
          "Early in a match, patience is cheap because you have time to spend. Late, the same decision may favour speed, because a correct move that arrives after the match ends is worth nothing.",
          "Players who seem to change personality mid-match are not becoming reckless. They are repricing the same trade-off as the time budget shrinks.",
        ],
      },
      {
        heading: "Choose a tempo before the first card",
        paragraphs: [
          "Decide what kind of deal you are playing after the first few reveals. A board with open columns and accessible aces rewards speed; a board with buried kings rewards caution. Committing to one tempo early prevents hesitation later.",
          "In Solitaire Duel specifically, the tempo should match the deal rather than your mood. The same player can be aggressive in one match and patient in the next, and that is consistency with the position, not inconsistency.",
        ],
      },
      {
        heading: "Rehearse the fast decisions slowly",
        paragraphs: [
          "Speed in a race comes from making fewer decisions, not from moving your hand faster. The way to build that is to rehearse the common shapes slowly, so the choice between them is already settled when the clock arrives.",
          "Use solo games for this. Pause on each reveal and name the two moves you would consider, then decide. After a few sessions the pair is recognised instantly, and the race becomes execution rather than deliberation. Keep the drill short: ten minutes of deliberate pauses teaches more than an hour of fast play, because the point is to build the judgement you will later use at speed.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["how-solitaire-duel-scoring-works", "reading-your-opponent-in-solitaire"],
  },

  {
    slug: "is-solitaire-a-skill-game",
    title: "Is Solitaire a Skill Game?",
    metaDescription:
      "A clear answer to whether Klondike rewards skill: the deal is random, the play is not, why an identical deal is the fairest comparison, and what an Elo rating can and cannot tell you.",
    h1: "Is Solitaire a skill game?",
    summary:
      "Solitaire is often dismissed as luck because the deal is random. That misses the actual question: does the player control enough of the outcome for a better player to win more often? Here is how to answer it honestly, without overclaiming.",
    sections: [
      {
        heading: "The deal is chance; the play is not",
        paragraphs: [
          "A shuffled deck is random, and no amount of skill changes which cards arrive. But the deal is only the starting position. Everything after it, which cards you uncover, which you promote and which columns you open, is a decision.",
          "A game is not unskilled because it contains randomness. It is unskilled when the randomness decides the result regardless of what the player does.",
        ],
      },
      {
        heading: "The symmetry test",
        paragraphs: [
          "The useful test is whether both players face the same randomness. In Solitaire Duel they do: one deterministic deal is served to both seats, so neither can be luckier than the other. The difference between them is what they do with it.",
          "Compare that with a game where each player draws a separate deck. Both might be random, but the comparison is no longer fair, because the inputs differ.",
        ],
      },
      {
        heading: "Why an identical deal is the fairest comparison",
        paragraphs: [
          "When the deal is shared, a match becomes a controlled experiment. The board is constant, so the only variable is execution: reading, sequencing and the number of corrections.",
          "That is also why a single result is not proof of much. Over many matches, the player who executes better will win more often, which is exactly what a rating is designed to detect.",
        ],
      },
      {
        heading: "What a rating measures",
        paragraphs: [
          "A per-game Elo rating summarises results over time. It moves when you win or lose against opponents of a given strength, and it does not move for solo or practice games. It is a record of competitive outcomes, not a measure of talent.",
          "That distinction matters. A rating can tell you whether your results are improving; it cannot tell you why, and it cannot promise that a specific deal will go your way.",
        ],
      },
      {
        heading: "The honest answer about one match",
        paragraphs: [
          "Any single deal can be lost through a small mistake or won through a lucky line, and no rating changes that. The skill claim is about the distribution of results, not about certainty in one game.",
          "That is true of chess, tennis and every other competitive activity. The right question is not whether one match was fair, but whether the better player wins more often over a series. On a shared deal, the answer is yes.",
        ],
      },
      {
        heading: "Where the skill actually lives",
        paragraphs: [
          "If you want to know which part of Klondike rewards ability, look at the decisions that change the board permanently: which hidden card to uncover, which low card to promote, and when to spend an empty column.",
          "Those choices are not equally valuable. The last one is usually the most consequential, because an empty column is the only resource the deal cannot give back once it is spent. Everything else on the board can be rearranged later; an emptied column cannot be unspent, and a promoted card can always come back down.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["how-solitaire-duel-scoring-works", "how-to-practice-solitaire"],
  },

  {
    slug: "how-to-concentrate-on-solitaire",
    title: "How to Concentrate During a Solitaire Match",
    metaDescription:
      "Focus techniques for a Solitaire race: clearing attention residue before you queue, making your setup dull, using a pre-match routine and stopping before your accuracy fades.",
    h1: "How to concentrate during a Solitaire match",
    summary:
      "Concentration in solitaire is not willpower. It is the absence of competing demands on your attention, which you can arrange before a match instead of summoning during one. These are the conditions that make focus the default rather than an effort.",
    sections: [
      {
        heading: "Attention residue and the first thirty seconds",
        paragraphs: [
          "When you switch tasks, part of your attention stays behind. Starting a match straight after answering a message means beginning with part of your mind elsewhere, and in a race decided by a handful of decisions that is a real handicap.",
          "Build a short gap before you queue. A minute with nothing incoming is enough for the residue to clear, and it is the cheapest concentration improvement available.",
        ],
      },
      {
        heading: "Make your setup dull on purpose",
        paragraphs: [
          "Every notification is a decision you did not choose to make. Silence messages, close unrelated tabs, and put the phone out of reach rather than face down on the desk, where it still pulls at you.",
          "Keep the rest of the environment stable too: same posture, same screen brightness, same seat. Novelty is interesting, and interesting is the opposite of what you want during a race.",
        ],
      },
      {
        heading: "A pre-match routine you can repeat",
        paragraphs: [
          "A consistent thirty-second routine before each match, with the same posture and the same breath, gives you a reliable cue that the game is starting and the rest of the day is stopped.",
          "Routines work because they remove decisions. They also help you notice when you have skipped one, which is often the first sign that you are playing while tired or distracted.",
        ],
      },
      {
        heading: "Anchor on the next reveal",
        paragraphs: [
          "During the match, keep your attention on the next hidden card rather than on the score. The score is an outcome; the next reveal is the thing you can actually act on.",
          "In a long or tight deal this prevents the two failure modes that cost most: staring at a board without a plan, and jumping between columns without finishing a line of thought.",
        ],
      },
      {
        heading: "Stop when the mistakes repeat",
        paragraphs: [
          "The first sign of fading attention is usually a mistake you can explain afterwards and would not have made an hour earlier. The second such mistake is a stop signal, not something to push through.",
          "Attention you spend recovering is attention you do not have for the next match. Ending a session early is how you make the next one repeatable.",
        ],
      },
      {
        heading: "Give the screen one job",
        paragraphs: [
          "A browser tab is a stack of invitations: another queue, a leaderboard, a message. During a match, close or hide everything that is not the board, including the tabs you are not looking at but are still thinking about.",
          "Single-purpose attention is easier to hold than divided attention, and the change is mechanical rather than motivational. You are not trying to care more; you are removing the alternatives. Do it before you queue rather than after the first mistake, because the cost of a distracted opening is paid in the part of the deal you cannot replay.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["solitaire-memory-techniques", "recovering-from-a-solitaire-losing-streak"],
  },

  {
    slug: "how-to-practice-solitaire",
    title: "How to Practise Solitaire Deliberately",
    metaDescription:
      "How to practise Klondike rather than just play it: separating practice from ranked matches, choosing one variable, using bot games for repetitions, and measuring something smaller than Elo.",
    h1: "How to practise Solitaire deliberately",
    summary:
      "Playing more is not the same as practising. Practice is a loop: choose something narrow, do it under conditions you control, measure whether it worked, and change one variable at a time. Here is how to run that loop on a Solitaire ladder.",
    sections: [
      {
        heading: "Practice is a loop, not more games",
        paragraphs: [
          "Ranked matches are a test. They tell you where you stand and they are poor at letting you work on a specific weakness, because you cannot choose the deal you get.",
          "Keep the two modes distinct. Practice is where you isolate a habit; ranked is where you find out whether it survived contact with an opponent. Decide which one you are doing before you sit down.",
        ],
      },
      {
        heading: "Choose one variable per block",
        paragraphs: [
          "If you change nothing specific, your practice is just more games. Pick one thing: how quickly you scan for hidden cards, whether you promote low cards immediately, or how often you cycle the stock without a reason.",
          "One variable at a time is not pedantry. Change three things and improve, and you have learned nothing about which change helped.",
        ],
      },
      {
        heading: "Use the bot for repetitions",
        paragraphs: [
          "Unrated practice against the bot exists so you can repeat a situation without an opponent's tempo deciding your repetitions. Arrive with a question and leave with an answer.",
          "Then take it into ranked play, where the result counts. Practice that never gets tested is a hobby; competition with no practice in between is just variance.",
        ],
      },
      {
        heading: "Measure something smaller than Elo",
        paragraphs: [
          "Ratings are the long-run measure and they move slowly, which makes them poor feedback inside a session. Pick a smaller number: how many deals you finished without cycling the stock twice, or how often your first three moves revealed a card.",
          "Small measurements move quickly enough to tell you whether the change is working. That is what keeps practice from feeling like blind repetition.",
        ],
      },
      {
        heading: "Write the review before you close the tab",
        paragraphs: [
          "Leave two minutes at the end of a block to write down what changed and what did not. This is the step almost everyone skips, and it is the one that turns a week of sessions into a plan.",
          "If you cannot say what you learned, you spent the time playing rather than practising. That is fine, as long as you are honest about which one you intended.",
        ],
      },
      {
        heading: "Use one deal, not twenty, for a drill",
        paragraphs: [
          "Repetition is how a habit becomes automatic, and a single deal can be repeated more usefully than a dozen fresh ones. Replay the same board and try a different first three moves; the comparison is controlled because nothing else changed.",
          "This is where solo Klondike earns its place in a training plan. It gives you the same rules without the clock, so you can run the experiment as many times as you need before testing it in ranked play. Change one thing between attempts, keep the rest identical, and the comparison stays honest instead of becoming a story about how the cards fell.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["building-a-solitaire-practice-routine", "speed-versus-accuracy-in-solitaire"],
  },

  {
    slug: "reading-your-opponent-in-solitaire",
    title: "Reading Your Opponent in a Solitaire Race",
    metaDescription:
      "What an opponent's pace and progress actually tell you in Solitaire Duel, why a lead is not a result, how not to inherit their tempo, and when the clock justifies a risk.",
    h1: "Reading your opponent in a Solitaire race",
    summary:
      "In a Solitaire Duel you cannot see your opponent's cards, and you do not need to. The useful information is the pace of the race and what their progress implies about the position, not a read on their personality.",
    sections: [
      {
        heading: "You are racing a person, not a puzzle",
        paragraphs: [
          "Solo solitaire is you against the board. A duel adds a second clock and a second set of decisions, and the match is decided by which of you reaches the end first, not by whether the board is solvable.",
          "That changes the value of a move. A cautious line that would be correct alone can lose a race, and an aggressive line that risks a correction can win one.",
        ],
      },
      {
        heading: "What a progress lead does not tell you",
        paragraphs: [
          "A lead on the progress measure means your opponent has advanced further, not that they have solved the deal. Progress can stall when the remaining cards are buried, so a lead can disappear quickly.",
          "The mistake is treating a lead as a result. Keep playing the position in front of you; the scoreboard is a symptom, and the board is the cause.",
        ],
      },
      {
        heading: "Do not inherit their tempo",
        paragraphs: [
          "It is easy to speed up because the other seat appears to be moving fast. That is usually a mistake: their speed tells you about their board, not about yours, and copying it can push you into corrections you do not need.",
          "Play the tempo your deal rewards. If your board has accessible aces and open columns, be fast. If it has buried kings, be deliberate, even if the progress bar suggests otherwise.",
        ],
      },
      {
        heading: "When the clock justifies a risk",
        paragraphs: [
          "Late in a match, the arithmetic changes. A safe line that finishes after the clock is worth nothing, while a risk that could unlock the deal is worth taking even if it sometimes fails.",
          "The judgement is about the remaining time and the remaining line, not about nerves. If the safe route cannot finish in time, the risky route is the correct one.",
        ],
      },
      {
        heading: "Compete with the position",
        paragraphs: [
          "The most reliable way to beat an opponent is to make fewer corrections on the same deal. That is a property of your play, not of theirs, and it is the part you can control.",
          "Watch the race, note the pace, and then ignore it. The board in front of you is the only thing you can actually solve.",
        ],
      },
      {
        heading: "Notice the shape of the race, not the score",
        paragraphs: [
          "A race has phases. Early, both seats are uncovering cards and the progress gap is noisy. Later, the gap reflects who has a workable line and who is stuck. Treat the same gap differently depending on the phase.",
          "A two-card lead with half the deal left is not the same as a two-card lead in the last thirty seconds. The number matters only in relation to how much of the board is still hidden. Ask what the lead would have to mean for you to change your plan; if you cannot answer, the lead is not actionable and the board still is.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["is-solitaire-a-skill-game", "speed-versus-accuracy-in-solitaire"],
  },

  {
    slug: "recovering-from-a-solitaire-losing-streak",
    title: "How to Recover From a Solitaire Losing Streak",
    metaDescription:
      "Why Solitaire losing streaks happen, how to tell fatigue from tilt from a real leak, the break that actually resets you, and how to review one loss without spiralling.",
    h1: "How to recover from a Solitaire losing streak",
    summary:
      "A losing streak feels like evidence about your ability. Usually it is evidence about your last hour: fatigue, tilt, or ordinary variance. Sorting out which one you are in is the whole skill, and it takes less time than queueing for another match.",
    sections: [
      {
        heading: "Variance looks like a streak",
        paragraphs: [
          "Any race produces runs, including runs of losses for players who are improving. A short streak carries very little information about whether you are good, which is why playing on tilt to prove the streak wrong is such a bad trade.",
          "Per-game ratings smooth exactly this out. A handful of losses barely moves a rating that many matches built, because the ladder is a long-term instrument and your last three games are noise around it.",
        ],
      },
      {
        heading: "Sort the run into fatigue, tilt or a leak",
        paragraphs: [
          "A streak usually has one dominant cause, and the fix is different for each. Fatigue shows up as mistakes you can explain and would not normally make. Tilt shows up as a change in tempo and risk-taking after a frustrating loss.",
          "A real leak looks different again: the losses share a pattern, such as the same opening error or the same refusal to spend an empty column. That is a lesson, not a streak, and it is worth writing down.",
        ],
      },
      {
        heading: "Take a break that actually resets",
        paragraphs: [
          "The standard advice is to stop after two or three losses, and it is standard because it works. Stay at the desk and you will keep playing; stand up, leave the screen for ten minutes, and come back to a different task.",
          "If you want to keep playing, switch modes rather than pushing on. An unrated game lets you rebuild rhythm with nothing on the line, which is the state you want to return to competition in.",
        ],
      },
      {
        heading: "Rebuild rhythm in unrated modes",
        paragraphs: [
          "Solo, the daily challenge and bot practice are all unrated. They are the right place to slow down and check whether the problem is your decisions or your state.",
          "Use them deliberately: pick one habit, play a few deals, and see whether the mistakes disappear. If they do, the streak was about you, not about the game.",
        ],
      },
      {
        heading: "Review one loss, then stop for the day",
        paragraphs: [
          "Once you are calm, pick a single loss, the most typical rather than the worst, and find the first move you would change. One loss, one lesson.",
          "That is how a streak becomes a study plan instead of a story about your ability. Then close the game for the day; the ladder will still be there tomorrow.",
        ],
      },
      {
        heading: "Keep a short record of what changed",
        paragraphs: [
          "A streak is hard to judge from memory because the last result dominates it. Keep a line per session: the mode, the result, and the one thing you were working on. Three lines are enough to show whether the problem is you or the session.",
          "It also gives you something to compare against when the streak ends. Most runs look obvious in hindsight and invisible while you are inside one, which is exactly why the record is worth the ten seconds.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["how-to-concentrate-on-solitaire", "building-a-solitaire-practice-routine"],
  },

  {
    slug: "building-a-solitaire-practice-routine",
    title: "Build a Solitaire Practice Routine That Sticks",
    metaDescription:
      "A repeatable Solitaire routine: deciding what a session is for, warming up on the real board, capping the session, reviewing in one sentence and rehearsing in unrated modes.",
    h1: "Build a Solitaire practice routine",
    summary:
      "A practice routine is not a schedule for playing more. It is a small set of decisions that make each session teach you something. This is the routine that fits a Solitaire ladder, and it takes less time than the matches it supports.",
    sections: [
      {
        heading: "Decide what the session is for",
        paragraphs: [
          "A session with no objective becomes whatever the first result makes it. Win and you queue again to keep the feeling; lose and you queue again to fix it. Either way you are playing for a mood rather than a skill.",
          "Pick one thing per session, such as holding accuracy under a clock or promoting low cards immediately, and judge the session on that rather than on the win-loss record.",
        ],
      },
      {
        heading: "Warm up on the real board",
        paragraphs: [
          "Warm-up should be a smaller version of the real thing: a few minutes of the exact decisions the match will ask for, at a pace you control. Reading something unrelated does not prepare the skill you are about to use.",
          "Solo Klondike is a good warm-up because it uses the same rules without a clock. Play a short game, focus on reveals and promotion, then move to ranked when the habits feel automatic.",
        ],
      },
      {
        heading: "Cap the session before attention does",
        paragraphs: [
          "Attention depletes, and the last half hour of a long session usually reinforces habits rather than teaching new ones. Decide a session length in advance and treat the cap as part of the training.",
          "Ending on a deal you understand, win or lose, is better than ending on a blur of matches where you cannot name what went wrong. If you cannot describe the last deal, it is time to stop.",
        ],
      },
      {
        heading: "Review in one sentence",
        paragraphs: [
          "Directly after a match, write one sentence: the single decision that decided it. Not a paragraph, not a self-assessment, one sentence.",
          "Over a week, the sentences repeat. When one repeats three times, that is the thing to work on next, and it is usually narrow and trainable.",
        ],
      },
      {
        heading: "Rehearse in unrated modes, not to relax",
        paragraphs: [
          "Unrated modes exist to let you rehearse something specific without the pressure of a ranked result. The habit worth building is arriving with a question and leaving with an answer.",
          "Because ranked matches are free and move a rating rather than a pot, the cost of a loss is informational. That makes a session which ends with a lesson a genuinely good outcome, which is exactly the mindset a routine is meant to build.",
        ],
      },
      {
        heading: "Protect the routine from your best intentions",
        paragraphs: [
          "Most routines fail because they are too large. A ninety-minute plan survives until the first busy evening, then disappears. A twenty-minute plan with one drill and one sentence of review survives the week.",
          "Make the smallest version the default and treat the longer session as a bonus. Consistency is what compounds here, and a routine you actually repeat beats a better one you skip. Write the small version down somewhere you will see it, because a routine that lives only in your head competes with everything else you meant to do that evening.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: ["how-to-practice-solitaire", "recovering-from-a-solitaire-losing-streak"],
  },

  {
    slug: "solitaire-game-review-explained",
    title: "Solitaire Move Analysis: How Game Review Works",
    metaDescription:
      "How a GRYND Solitaire Game Review rates moves, finds the turning points, shows the better move and links the mistake to a practice drill — and what it deliberately does not claim.",
    h1: "Solitaire move analysis, explained",
    summary:
      "A Game Review replays the deal you actually played and rates the decisions you made with the information you had at the time. This is what the labels mean, which moments are worth your attention, and how to turn one review into a practice session that changes the next game.",
    sections: [
      {
        heading: "What the review replays",
        paragraphs: [
          "Every completed game stores the deal and the ordered log of accepted moves. Game Review rebuilds the position before each move from that deal and that prefix of the log — there is no stored board per move and no reconstruction from memory. You can step forward, step back, jump to the start or the end, or scrub the timeline.",
          "Because the replay is the same rules engine that refereed the match, the review can never show a position the game could not have reached. Cards that were face down at that moment stay face down: the analysis rates your decision using what you could see, never the identities underneath.",
        ],
      },
      {
        heading: "What the labels mean",
        paragraphs: [
          "A move is only labelled when the engine can compare it with a concrete alternative on that board. Great and good marks a move that gains something measurable — a foundation card, a revealed card, an opened column — compared with what else was available. Inaccuracy and mistake mark the reverse: a legal move that gave up more than it gained when a better one was on the board.",
          "Routine card placements and stock passes are deliberately not commented on. A review that narrates every move trains you to skim it. If the summary says you made two mistakes in ninety moves, the other eighty-eight do not need your attention.",
        ],
      },
      {
        heading: "The better move, and why it comes with a picture",
        paragraphs: [
          "On a flagged move the review can show the alternative it preferred and the reason, measured from the same position. Where the engine is confident it also rebuilds two read-only positions: the board immediately before your move, and the same board with the recommended move applied. Nothing about the demonstration is recomputed by the page — the engine's own move is applied and checked.",
          "Confidence matters. An uncertain position is not presented as a mistake you must accept; the recommendation simply is not shown. A review that always has an opinion is a review you cannot trust.",
        ],
      },
      {
        heading: "Turning points, not a transcript",
        paragraphs: [
          "The highlights panel collects a handful of moments: the strongest positive plays, the mistakes, and structural events such as opening a column, unlocking a long sequence or pulling a card back off a foundation. Each one jumps the board to that ply, so you can see the decision instead of reading about it.",
          "Read the highlights in game order once, then pick a single moment to understand properly. The point is not to audit every move; it is to leave with one decision you would make differently.",
        ],
      },
      {
        heading: "From a mistake to a drill",
        paragraphs: [
          "A flagged move is evidence about a concept, so the review maps it to the concept the engine actually measured: revealing hidden cards, foundation timing, opening columns, managing kings, stock-cycle planning or comparing sequences. Each concept has an existing Academy lesson and a validated practice drill built on prepared boards.",
          "The drill is not a copy of your deal and does not reuse its seed. It teaches the decision in isolation, then returns you to the exact ply you were reading. Practice never touches your rating, and your practice record stays on your device.",
        ],
      },
      {
        heading: "What the review will not tell you",
        paragraphs: [
          "It will not give you a single accuracy percentage, a grade or a skill rating. Those numbers are easy to produce and hard to justify: the same move can be correct in one deal and wrong in another, and a percentage hides which decision cost you the race.",
          "It will also not analyse a game you did not finish. A forfeit or an abandoned board is still replayable, so you can see what happened, but rating an unplayed game would be inventing evidence. And it will not compare you with other players: the review is about your decisions on your deal.",
        ],
      },
      {
        heading: "A five-minute routine that uses it",
        paragraphs: [
          "Open the review of your last completed game and read only the highlights. Pick the one moment you did not see coming, step through the recommended alternative once, then open the linked drill and finish it. Close the review.",
          "Do that after a loss and you have converted a result into a specific, rehearsed correction. Do it after a win and you have found the decision that nearly cost you the game — which is usually the more useful of the two.",
        ],
      },
    ],
    gameSlugs: ["solitaire-duel"],
    relatedGuides: [
      "solitaire-mistakes-to-avoid",
      "how-to-practice-solitaire",
      "speed-versus-accuracy-in-solitaire",
    ],
  },
];

/**
 * Retired guide slugs and their replacements.
 *
 * The library used to cover games the platform no longer offers. Those URLs are
 * indexed, so they must not 404: next.config.js 308s each one to its closest
 * surviving article, and src/proxy.ts applies the same map before its
 * unknown-slug guard (the proxy must not depend on the router's ordering).
 */
export const LEGACY_GUIDE_SLUGS: Readonly<Record<string, string>> = {
  "how-to-improve-typing-speed": "how-to-play-klondike-solitaire",
  "how-to-get-better-at-sudoku": "how-to-win-solitaire-more-often",
  "reaction-time-in-competitive-games": "how-solitaire-duel-scoring-works",
  "memory-techniques-for-competitive-games": "solitaire-memory-techniques",
  "speed-versus-accuracy": "speed-versus-accuracy-in-solitaire",
  "how-to-improve-at-chess": "solitaire-strategy-for-beginners",
  "building-competitive-habits": "building-a-solitaire-practice-routine",
  "what-makes-a-game-skill-based": "is-solitaire-a-skill-game",
  "improve-concentration": "how-to-concentrate-on-solitaire",
  "how-to-practice-competitive-games": "how-to-practice-solitaire",
  "reading-your-opponent": "reading-your-opponent-in-solitaire",
  "recovering-from-a-losing-streak": "recovering-from-a-solitaire-losing-streak",
  "dominoes-strategy": "solitaire-mistakes-to-avoid",
};

/** Slugs that have a public guide page, in catalog order. */
export const GUIDE_SLUGS: readonly string[] = GUIDES.map((guide) => guide.slug);

/** slug → guide. */
export const GUIDE_BY_SLUG: Readonly<Record<string, Guide>> = Object.fromEntries(
  GUIDES.map((guide) => [guide.slug, guide])
);

/** The public path for a guide. */
export function guidePath(slug: string): string {
  return `/guides/${slug}`;
}

/** The guide index path. */
export const GUIDES_INDEX_PATH = "/guides";

/** The absolute URL for a guide, on the canonical origin. */
export function guideUrl(slug: string): string {
  return `${SITE_ORIGIN}${guidePath(slug)}`;
}

/** True when a slug has a public guide page. */
export function isGuideSlug(slug: unknown): boolean {
  return typeof slug === "string" && Object.hasOwn(GUIDE_BY_SLUG, slug);
}

/** Resolve a guide's "read next" slugs to their catalog entries. */
export function relatedGuidesFor(slug: string): Guide[] {
  const guide = GUIDE_BY_SLUG[slug];
  if (!guide) return [];
  return guide.relatedGuides
    .map((relatedSlug) => GUIDE_BY_SLUG[relatedSlug])
    .filter((entry): entry is Guide => Boolean(entry));
}

/** Every guide that lists a game slug, in catalog order. */
export function guidesForGame(gameSlug: string): Guide[] {
  return GUIDES.filter((guide) => guide.gameSlugs.includes(gameSlug));
}

/**
 * A minimal projection for surfaces that list guides (the /guides index and
 * the game pages) without pulling the whole article prose into a client
 * bundle. Same pattern as GameIndexEntry in src/lib/gameLandingPages.ts.
 */
export type GuideIndexEntry = {
  slug: string;
  title: string;
  metaDescription: string;
};

/** Every guide, in catalog order, as an index entry. */
export const GUIDE_INDEX: readonly GuideIndexEntry[] = GUIDES.map(
  ({ slug, title, metaDescription }) => ({ slug, title, metaDescription })
);
