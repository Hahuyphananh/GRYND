// src/lib/guides.ts
//
// THE GUIDES LIBRARY — a SMALL set of genuinely useful, original articles
// about the skills GRYND's games actually test.
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// The site's public pages explained WHAT each game is (see
// src/lib/gameLandingPages.ts) but nothing taught a visitor how to get better
// at the skills those games measure. This module is the missing layer: a
// dozen guides, each about one transferable skill or one practical question,
// written to be read rather than skimmed by a crawler.
//
// ── The rules every guide here follows ────────────────────────────────────
//
//   * NO SPAM. Twelve guides, not twelve hundred. Each one answers a question
//     a real player has, and the set is closed until there is a genuinely new
//     question to answer.
//   * NO FAKE AUTHORITY. There are no invented authors, no invented review
//     counts and no invented statistics. Where a number appears it is a
//     mechanical fact of a GRYND game (mine values, the Memory Grid ramp, the
//     Speed Typing win condition), taken from that game's own server-side
//     source — the same rule src/lib/gameLandingPages.ts documents.
//   * NO KEYWORD STUFFING and no duplicated paragraphs. Two guides may both
//     mention Memory Grid because both genuinely concern it; they never make
//     the same point about it.
//   * NO INVENTED MECHANICS. Every GRYND-specific claim points at something
//     the game actually does today (stakes are retired, matches are free,
//     results move a per-game Elo rating and trophies). If a mechanic changes,
//     the guide that mentions it must change too — tests/guides.test.mjs
//     asserts each guide links only to real game pages, and that every guide
//     is reachable and indexable.
//
// ── Structure ─────────────────────────────────────────────────────────────
//
// Guides are DATA, rendered by one server component
// (src/components/guides/GuideArticle.tsx) so no page duplicates JSX and the
// whole article is in the HTML response with no JavaScript required.

/** The canonical origin the public site is served from. */
export const SITE_ORIGIN = "https://grynd.dedyn.io";

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
    slug: "how-to-improve-typing-speed",
    title: "How to Improve Your Typing Speed",
    metaDescription:
      "How to type faster without typing worse: measuring an honest baseline, why accuracy comes first, which drills transfer to a timed race, and how Speed Typing decides a match.",
    h1: "How to improve your typing speed",
    summary:
      "Typing speed is one of the few competitive skills you can measure in a single number and train in ten-minute blocks. The catch is that the number most people chase — raw speed — is the one that loses races. This guide covers measuring your real baseline, fixing accuracy first, the drills that actually transfer, and how all of it plays out in Speed Typing.",
    sections: [
      {
        heading: "Measure a baseline you can trust",
        paragraphs: [
          "Before changing anything, type a passage you have never seen for sixty seconds and write down two numbers: your speed and your accuracy. A number produced from a passage you have already memorised measures recall, not typing, and it will always be flattering.",
          "Repeat the test the same way — same keyboard, same posture, same time of day — so the numbers are comparable. Progress in typing is slow and uneven, and a baseline you retest inconsistently will convince you that you are stuck when you are not.",
        ],
      },
      {
        heading: "Accuracy is the skill; speed is the result",
        paragraphs: [
          "Fast typists are not people who move their fingers faster. They are people who make fewer corrections. Every wrong key costs you three times over: the wrong character, the time to notice it, and the time to fix it. A typist who never backspaces is effectively faster than a quicker typist who corrects twice a sentence, even if the second one's fingers are moving faster.",
          "So drill accuracy first. Type slowly enough that you can finish a passage with no errors at all, then let the speed arrive on its own. If you are making more than roughly one mistake per twenty words, you are practising your mistakes.",
        ],
      },
      {
        heading: "Use the home row and stop watching your hands",
        paragraphs: [
          "Touch typing — keeping your fingers anchored on the home row and trusting them — is the single biggest structural improvement available to most players. Looking down at the keyboard forces a visual check between every keystroke, and that check is where beginners lose most of their time.",
          "If you cannot yet type without looking, practise short, easy passages with the screen dimmed or your hands covered. It is slower for a week and faster forever.",
        ],
      },
      {
        heading: "Drill the things a random passage will not teach you",
        paragraphs: [
          "Random text samples every letter equally, which is not how real text is distributed. Spend part of each session on the transitions you actually fumble — letter pairs like `th`, `in`, `er`, `ou` and the capitals and punctuation that break your rhythm. A drill can be boring and still be useful; the point is repetition, not novelty.",
          "Then rehearse the thing you are actually training: a match. Type whole sentences at race pace, not isolated words, because the skill you need is holding accuracy while reading ahead.",
        ],
        bullets: [
          "Warm up for two minutes before a session — cold hands fumble more than tired ones.",
          "Read one word ahead of the word you are typing; your hands will follow your eyes.",
          "Never look at the keyboard to check a mistake. Look at the screen.",
          "Stop a drill when accuracy drops. Grinding out sloppy repetitions teaches sloppiness.",
        ],
      },
      {
        heading: "How this plays out in Speed Typing",
        paragraphs: [
          "In Speed Typing, both seats receive the same server-selected passage and the first player to type it correctly wins. There is no partial credit for getting most of the way there, and no benefit to finishing a sentence you typed wrong — which makes it a pure test of the accuracy-first approach this guide describes.",
          "Because the passage is identical for both players, you cannot win by getting lucky with an easy text. The race is decided by who makes fewer corrections under a clock, so the drills above are the whole training plan: read ahead, hold accuracy, and let speed follow.",
        ],
      },
    ],
    gameSlugs: ["speed-typing", "precision"],
    relatedGuides: ["speed-versus-accuracy", "how-to-practice-competitive-games"],
  },

  {
    slug: "how-to-get-better-at-sudoku",
    title: "How to Get Better at Sudoku",
    metaDescription:
      "A method for solving Sudoku faster and more reliably: naked and hidden singles, disciplined pencil marks, a scanning order that finds forced moves, and why guessing is the slow route.",
    h1: "How to get better at Sudoku",
    summary:
      "Most Sudoku players do not lose on hard puzzles because the puzzle is too hard. They lose because they guess early, write down too much, and then have to unpick their own notes. This guide is about the method that makes puzzles fall faster: work only with forced moves until there are none left.",
    sections: [
      {
        heading: "Understand what a valid move is",
        paragraphs: [
          "Every Sudoku cell is defended by three constraints at once: the row, the column and the 3×3 box it sits in. A digit is only legal in a cell if it appears in none of the three. Internalising that triangle is the difference between scanning and guessing — you are looking for the intersection, not filling the first gap you see.",
        ],
      },
      {
        heading: "Start with singles, in the right order",
        paragraphs: [
          "A naked single is a cell where eight of the nine digits are already eliminated, so exactly one can go there. A hidden single is a cell that is one of several candidates, but where a digit can fit in only one cell of a row, column or box. Both are forced moves, and forced moves are free.",
          "Scan for hidden singles before naked ones when a grid looks stuck. They are easier to miss and more common than people expect, and a puzzle that seems to require a guess usually still has a hidden single in it.",
        ],
        bullets: [
          "Sweep one digit across the whole board at a time before moving to the next.",
          "Check every box for a digit that can only land in one square.",
          "When you place a digit, re-check its row, column and box — placements create new singles.",
        ],
      },
      {
        heading: "Keep pencil marks disciplined, or keep none at all",
        paragraphs: [
          "Full pencil marks are powerful and dangerous. Writing every candidate in every cell turns a puzzle into a wall of digits you have to read every time you scan, which is slower than the puzzle deserves. A workable middle ground: pencil-mark only the cells you are actively reasoning about, and erase a mark the moment it becomes impossible.",
          "The worst habit is leaving a stale mark in place after the situation changed. A wrong note is worse than no note, because it makes a forced move look unavailable.",
        ],
      },
      {
        heading: "Prefer a slow correct move to a fast guess",
        paragraphs: [
          "Guessing is not just risky — it is expensive. A wrong guess can sit in the grid for several minutes before you notice, and by then you have built reasoning on top of it. If no forced move exists, look harder rather than writing a digit you cannot justify; there is almost always one more elimination to make.",
          "This is the habit that transfers directly into Sudoku Duel, where the server generates one puzzle and both seats solve the same grid simultaneously with no time limit. Because there is no clock to force your hand, the player who stays on forced moves and never has to back out of a mistake almost always finishes first — patience is the faster strategy, which surprises people who expect a solving race to reward speed above everything.",
        ],
      },
      {
        heading: "A short daily routine",
        paragraphs: [
          "Solve one puzzle a day at the hardest level you can complete without guessing, and after each one, note the single moment you found hardest. That note is your training plan: tomorrow, look for that pattern first. Improvement in Sudoku comes from recognising more patterns, and you only recognise the ones you have deliberately looked for.",
        ],
      },
    ],
    gameSlugs: ["sudoku-duel"],
    relatedGuides: ["improve-concentration", "speed-versus-accuracy"],
  },

  {
    slug: "reaction-time-in-competitive-games",
    title: "How Reaction Time Affects Competitive Play",
    metaDescription:
      "What reaction time really measures, why anticipation beats raw reflexes, how display and input delay quietly cost you milliseconds, and where timing decides a GRYND match.",
    h1: "How reaction time affects competitive play",
    summary:
      "Reaction time is treated as a fixed personal trait, like height. It is closer to a trainable skill with a large anticipation component, and on a screen the biggest number in the equation is usually not your nerves at all — it is how quickly you already knew what was coming.",
    sections: [
      {
        heading: "Reaction time is two skills, not one",
        paragraphs: [
          "A simple reaction is one known stimulus, one known response. A choice reaction is a signal you have to identify before you respond, and it is dramatically slower — which is why good players are rarely the ones with the fastest fingers. They are the ones who have narrowed the number of things the signal could be.",
          "This is why anticipation is not cheating and not luck. If you already know that the next input will be one of two options, you are running a choice reaction with a much smaller choice.",
        ],
      },
      {
        heading: "Find your real latency and remove the avoidable part",
        paragraphs: [
          "Before training anything, make sure what you are measuring is you and not your setup. A television in picture mode, a wireless mouse reporting at a low rate, or a browser tab under heavy load all add delay that feels like slow reflexes and cannot be trained away.",
          "Play on the display mode with the least processing, keep your computer idle of background work during a match, and use a consistent setup. Removing fifty milliseconds of display lag is worth months of reaction drills.",
        ],
      },
      {
        heading: "Warm up: reaction time is state-dependent",
        paragraphs: [
          "Cold reaction times are reliably worse than warmed-up ones, and the warm-up that helps most is specific: a minute of the exact input the game asks for, at a pace you can control. Reading a book warms nothing you need.",
          "Fatigue, caffeine and frustration all move reaction time, and none of them move it in a direction you can push through. A short break is often a faster recovery than another attempt.",
        ],
      },
      {
        heading: "Where timing actually decides a match here",
        paragraphs: [
          "Different GRYND games expose timing in very different ways, and training the wrong one wastes the session.",
        ],
        bullets: [
          "Precision is the purest test: you stop closest to a target, so the whole game is a judgement about when to commit, not how fast you can click. Practising calm, single, deliberate stops beats spamming inputs.",
          "In Rock-Paper-Scissors, a round resolves on one click in a best-of-seven series. There is no reaction window to speak of; the skill is reading the opponent's pattern, so speed is irrelevant and misreading your own tempo is the real risk.",
          "Lane Rush Duel rewards a template you can trust: knowing which move you will make before the situation arrives is what turns a choice reaction into a simple one.",
          "Mini Golf is timing under a physics model — your control is the power meter, and consistency at a familiar power setting beats trying to react to a perfect line.",
        ],
      },
      {
        heading: "Train the predictable part",
        paragraphs: [
          "Because choice reactions dominate, the highest-value training is not a reaction-time test — it is learning the game's patterns until fewer decisions are open to you. Study how a sequence usually unfolds, decide your default response in advance, and rehearse it. Your reaction time as a player is the sum of your reading speed and your reflexes, and reading is the half you can actually improve quickly.",
        ],
      },
    ],
    gameSlugs: ["precision", "rps", "lane-runner", "mini-golf"],
    relatedGuides: ["improve-concentration", "speed-versus-accuracy"],
  },

  {
    slug: "memory-techniques-for-competitive-games",
    title: "How Memory Affects Competitive Games",
    metaDescription:
      "Practical memory techniques for competitive play: chunking, spatial anchoring and rehearsal, why reconstructing a pattern beats trying to photograph it, and how Memory Grid's ramp works.",
    h1: "How memory affects competitive games",
    summary:
      "Memory in games is rarely about raw capacity. It is about how you encode what you saw, and whether your encoding survives the five seconds between seeing it and needing it. This guide covers the techniques that hold up under pressure, using the games where recall decides the result.",
    sections: [
      {
        heading: "Encode structure, not pixels",
        paragraphs: [
          "Trying to remember a lit grid as a photograph fails quickly, because raw visual detail is expensive to store. What holds is structure: which column, which row, which corner. Turn the pattern into a small number of relationships — 'two in the top row, one on the right edge, a cluster in the middle' — and you are storing three facts instead of a dozen coordinates.",
          "This is the same reason a phone number is easier to hold as three groups than as ten digits. Grouping is not a trick; it is how short-term memory works.",
        ],
      },
      {
        heading: "Reconstruct from the edges inward",
        paragraphs: [
          "When a pattern is flashed and then hidden, most people start in the middle and lose the whole thing when they cannot place the middle tiles. Start with the corners and edges, which are the easiest to locate spatially, then fill inward. Even if you cannot finish, a partially correct reconstruction scores better than a blank grid, and the edges are the anchors that let you place the rest.",
        ],
      },
      {
        heading: "Rehearse out loud, quietly",
        paragraphs: [
          "Verbal rehearsal — naming the positions to yourself during the exposure window — measurably beats silent staring, because it converts a visual trace into a second, independent trace. 'Top-left, top-right, centre.' The naming is the memory, not a distraction from it.",
          "The catch is timing. Rehearse during the reveal, not after it. Once the grid goes dark you should already be tapping, and hesitation is what erases the trace.",
        ],
      },
      {
        heading: "Where recall decides a match",
        paragraphs: [
          "Memory Grid is the direct test: five rounds on a fixed ramp, where both seats see the same pattern for the same exposure time — a 3×3 grid with three lit tiles and 2.5 seconds to start, rising to a 5×5 grid with fourteen tiles and four seconds by round five. Because the pattern and the window are identical for both players, nothing here is about luck; it is about encoding quality under a fixed deadline, and a level set of five rounds is broken by a sixth tiebreak round on a harder grid.",
          "Recall matters elsewhere too, just less mechanically. In Mines Duel you are reading and remembering which clue numbers touch which unrevealed tiles, and losing track of that is how players step on a mine. In Key-draw games like Keno, both seats see the same draw, and the player who remembers which numbers are still live makes faster decisions. In Pool Masters, the table is the memory: which balls have been potted and which pockets are still safe. Even Solitaire Duel rewards a clear picture of the deal you have already seen, because both seats solve the same deal and progress is what breaks a stalemate.",
        ],
      },
      {
        heading: "Two habits that protect memory",
        paragraphs: [
          "Sleep is the training, not the rest. Consolidation happens overnight, and a pattern you could not hold on five hours of sleep is often easy on eight. If you are drilling memory games seriously, the cheapest improvement available is a consistent bedtime.",
          "Second, do not run memory drills while distracted. Split attention destroys encoding at the first step, and no technique later in the pipeline recovers a pattern you never properly stored.",
        ],
      },
    ],
    gameSlugs: ["memory-grid", "mines-pvp", "keno", "pool-masters", "solitaire-duel"],
    relatedGuides: ["improve-concentration", "how-to-practice-competitive-games"],
  },

  {
    slug: "speed-versus-accuracy",
    title: "Speed vs Accuracy in Competitive Games",
    metaDescription:
      "When to play fast and when to be right: expected value in practice, the error costs in GRYND's games, and how to tell which side of the trade-off a match is actually paying for.",
    h1: "Speed versus accuracy in competitive games",
    summary:
      "Every competitive game asks the same question in a different costume: is it worth being faster at the risk of being wrong? The answer is never a personality trait — it is arithmetic about what a mistake costs and what a fast success earns. This guide shows how to read that arithmetic in the games you play.",
    sections: [
      {
        heading: "The trade-off is a price, not a philosophy",
        paragraphs: [
          "'Play fast' and 'play safe' are both bad advice on their own. What matters is the exchange rate: how much a mistake costs you relative to how much a quick correct action gains. Where mistakes are cheap and time is scarce, speed wins. Where mistakes are expensive and the clock is generous, patience wins.",
          "So the first thing to learn about any game is its penalty table, not its strategy tips. The penalties tell you which side of the trade-off the designer is paying you to take.",
        ],
      },
      {
        heading: "Read the penalty table",
        paragraphs: [
          "Two examples from GRYND's catalogue sit at opposite ends of this spectrum, and both are decided by their numbers rather than by player temperament.",
          "In Mines Duel, a safe reveal is worth five points, a wrong flag costs ten and stepping on a mine costs twenty-five — more than four safe reveals. A coin-flip guess that succeeds earns five and one that fails costs twenty-five, so a genuine fifty-fifty is a losing bet every time. The correct strategy is to spend the clock finding safe ground, and only gamble when the value of a correct flag (up to fifty points for the single high-value mine) actually outweighs the risk. Fast flagging is a trap.",
          "In Speed Typing it is the reverse. Both seats race the same passage and only a correct finish counts, so there is no penalty for pausing to check a word — but there is no reward for typing a sentence you will have to fix either. The clock is generous enough that the winning move is almost always a clean one: read ahead, hold accuracy, and let the finish come.",
        ],
      },
      {
        heading: "Match your tempo to the clock, not to your nerves",
        paragraphs: [
          "A shared clock changes the calculus over time. Early in a timed match, patience is cheap because you have clock to spend. Late, when the clock is short, the same decision may genuinely favour speed, because a correct slow action that arrives after the whistle is worth nothing.",
          "This is why good players seem to change personality mid-match. They are not becoming reckless; they are re-pricing the same decision as the time budget shrinks.",
        ],
      },
      {
        heading: "In a game with no clock, accuracy is almost always right",
        paragraphs: [
          "Sudoku Duel is the clean case: the server generates one puzzle, both seats solve it at once, and there is no time limit — the first correct board wins. In a race like that, someone will eventually be faster, but a wrong digit you have to find and undo costs far more than the seconds you saved typing it. When the only thing that ends the match is being right, being right is the whole strategy.",
        ],
      },
      {
        heading: "A weekly habit that fixes your default",
        paragraphs: [
          "After each session, note one decision where you chose speed and one where you chose accuracy, and whether the result justified it. Players who do this stop treating tempo as a mood and start treating it as a setting they choose per game. The same person should be cautious in Mines Duel and decisive in a Precision stop, and that is not inconsistency — it is reading the price.",
        ],
      },
    ],
    gameSlugs: ["mines-pvp", "speed-typing", "sudoku-duel", "precision"],
    relatedGuides: ["how-to-improve-typing-speed", "what-makes-a-game-skill-based"],
  },

  {
    slug: "how-to-improve-at-chess",
    title: "How to Improve at Chess",
    metaDescription:
      "A practical chess improvement plan: principles over memorised openings, tactics as the fastest rating gain, reviewing your own losses, and how 1v1 turn-based play builds the same habits as Hex Duel.",
    h1: "How to improve at chess",
    summary:
      "Chess improvement has a reputation for being slow and mysterious. In practice most players at club level are losing games to the same handful of avoidable mistakes, and fixing those moves the needle faster than studying openings ever will. This guide is an order of operations.",
    sections: [
      {
        heading: "Learn principles before moves",
        paragraphs: [
          "Openings are patterns, and patterns are easy to memorise and easy to misunderstand. Before you learn a single variation, learn what an opening is trying to accomplish: control the centre, develop your pieces, castle early, and do not move the same piece twice without a reason.",
          "A player who follows those four rules will come out of the opening reliably fine against most opponents, without memorising anything. A player who memorises ten moves but does not know why will be lost on move eleven, which is exactly when the game starts.",
        ],
      },
      {
        heading: "Spend most of your time on tactics",
        paragraphs: [
          "At every level below expert, tactics decide more games than strategy. A puzzle habit — fifteen minutes a day, calculated to the end rather than solved by feel — is the single highest-return investment in chess.",
          "The discipline that matters is calculating before moving: for each candidate move, look at the opponent's replies before you commit. Most lost games at club level are not lost by a brilliant opponent; they are lost by a player who stopped calculating one move too early.",
        ],
      },
      {
        heading: "Play games that are long enough to think in",
        paragraphs: [
          "Faster time controls are fun and improve your intuition, but if you only ever play blitz you will repeat the same mistakes faster instead of fixing them. Give yourself room to calculate, and accept that the loss you take while thinking is the one you learn from.",
        ],
      },
      {
        heading: "Review your own losses, not someone else's brilliancies",
        paragraphs: [
          "After a loss, replay it and find the first move you would change — not the last one, and not the opponent's best move. The earliest mistake is usually the real cause, and finding it once is worth more than watching a famous game you cannot yet appreciate.",
          "Write one sentence about what went wrong. Recurring sentences soon become a list of your actual weaknesses, which is a study plan no book can write for you.",
        ],
      },
      {
        heading: "The same habits work on Hex Duel",
        paragraphs: [
          "Hex Duel is a turn-based conquest duel where the win condition is specific: you win by capturing your opponent's capital tile, not by owning the most ground. That punishes exactly the mistake chess punishes — expanding faster than you can defend. Troops grow over time on tiles their owner holds, and each turn gives you a limited pool of action points, so a territorial lead that leaves your capital thin is not a lead at all.",
          "The transferable habit is the one above: before every move, ask what your opponent can do about it. In Hex Duel that means checking your own capital before you push; in chess it means calculating the reply before you commit. Same skill, different board.",
        ],
      },
    ],
    gameSlugs: ["chess", "hex-duel", "four-in-a-row", "tic-tac-toe"],
    relatedGuides: ["how-to-practice-competitive-games", "reading-your-opponent"],
  },

  {
    slug: "building-competitive-habits",
    title: "How to Build Better Competitive Habits",
    metaDescription:
      "A practical competitive routine: warm-up, one focused session at a time, reviewing results honestly, and the habits that separate steady improvement from grinding.",
    h1: "How to build better competitive gaming habits",
    summary:
      "Most players improve in bursts and then plateau for months, and the plateau is usually not a talent ceiling — it is a habit problem. The way you start a session, choose what to work on and how you stop decides whether your games teach you anything. This guide is the routine that does.",
    sections: [
      {
        heading: "Decide the point of the session before you play",
        paragraphs: [
          "A session with no objective becomes whatever the first result makes it. If you win, you queue again to keep the feeling; if you lose, you queue again to fix it. Either way you are playing for a mood rather than for a skill.",
          "Pick one thing per session — holding accuracy under a clock, reading an opponent's pattern, or simply staying calm after a loss — and judge the session on that, not on the win-loss record. You will still win or lose roughly the same number of games, but you will have spent the time deliberately.",
        ],
      },
      {
        heading: "Warm up on the game you are about to play",
        paragraphs: [
          "Warm-up should be a smaller version of the real thing: a couple of minutes of the exact input the game asks for, at a pace you control. Reading or watching something unrelated does not prepare the specific skill you are about to use.",
          "This matters most in the fast, mechanical games. A Speed Typing race or a Precision stop depends on timing and rhythm, and a cold start is measurably worse than a warmed-up one.",
        ],
      },
      {
        heading: "Cap the session, and stop on a lesson",
        paragraphs: [
          "Attention is a depleting resource, and the last half hour of a long session is usually spent reinforcing habits rather than learning new ones. Decide a session length in advance and treat the cap as part of the training.",
          "Ending on a game you understand — win or lose — is better than ending on a blur of matches where you can no longer tell what went wrong. If you cannot name one thing from the last game, it is time to stop.",
        ],
      },
      {
        heading: "Review in one sentence, immediately",
        paragraphs: [
          "Directly after a match, write one sentence: the single decision that decided it. Not a paragraph, not a self-assessment, one sentence. This takes fifteen seconds and is the difference between playing a hundred games and learning from a hundred games.",
          "Over a week, the sentences repeat. When one repeats three times, that is the thing to work on next — and it is usually something narrow and trainable, like over-expanding before defending in a conquest game, or flagging on a hunch in Mines Duel where a wrong flag costs ten and a safe reveal is only worth five.",
        ],
      },
      {
        heading: "Use practice mode to rehearse, not to relax",
        paragraphs: [
          "Every GRYND game with bot practice exists to let you rehearse something specific without the pressure of a ranked result. The habit worth building is arriving at practice with a question and leaving with an answer, rather than using it as a warm bath between ranked matches.",
          "Because ranked matches here are free to enter — nothing is wagered, and results move a per-game Elo rating and trophies instead of tokens — the cost of a loss is informational rather than financial. That makes 'I lost and learned the cause' a genuinely acceptable session outcome, which is exactly the mindset competitive habits are built on.",
        ],
      },
    ],
    gameSlugs: ["speed-typing", "precision", "mines-pvp"],
    relatedGuides: ["recovering-from-a-losing-streak", "how-to-practice-competitive-games"],
  },

  {
    slug: "what-makes-a-game-skill-based",
    title: "What Makes a Game Skill-Based?",
    metaDescription:
      "Skill and chance are not opposites: how randomness, information and rules determine who wins, and how to tell which part of a GRYND match your ability actually controls.",
    h1: "What makes a game skill-based?",
    summary:
      "'Skill-based' and 'lucky' are usually treated as a binary verdict on a whole game. That is the wrong lens. Almost every competitive game mixes a random element with a decision layer, and the interesting question is which part of a match your ability actually controls — and whether both players face the same randomness.",
    sections: [
      {
        heading: "Randomness is not the same as unfairness",
        paragraphs: [
          "A dice roll is random. A game where one player rolls dice and the other does not is unfair. Those are different properties, and conflating them is why so many arguments about luck in games go nowhere.",
          "What makes randomness acceptable in a competitive game is symmetry: the same random input applies to both seats, or the random outcomes are equally likely for both, and the match is won by what players do with what they are given. When that holds, randomness adds variance without deciding who is better over time.",
        ],
      },
      {
        heading: "The three questions that settle it",
        paragraphs: [
          "For any game, ask these in order. The answers tell you where your practice time should go.",
        ],
        bullets: [
          "Is the random input symmetric? In Keno, both seats receive the same draw, so the only difference between players is what they do with it. In Mines Duel, each seat gets its own board and the mine positions never match, but both boards are the same size, hold the same number of mines and use the same value table — so the scoring opportunity is equivalent even though the boards differ.",
          "How much of the outcome does a decision move? In Dice Flush, the dice are random but you decide which combinations to lock and when to stop; the roll sets the ceiling and your locking sets the result.",
          "Can a better player win more often over many matches? This is the practical test. Per-game Elo ratings exist precisely to answer it: results across a series reveal who is better, even when a single match goes the other way.",
        ],
      },
      {
        heading: "Perfect-information duels versus managed chance",
        paragraphs: [
          "At one end sit games like Chess, Tic-Tac-Toe, Four-in-a-Row and Dots & Boxes: nothing is hidden and nothing is drawn, so the outcome is a pure function of planning and reading the opponent. At the other end sit games built around a random input you manage rather than control.",
          "Most of GRYND's catalogue sits in between, and the useful thing to notice is which side your game leans toward. In a perfect-information duel, the way to improve is study and pattern recognition. In a chance-managed game, the way to improve is pricing risk — knowing when a gamble is worth taking and when it is simply a losing bet.",
        ],
      },
      {
        heading: "What GRYND does about the fair-play half",
        paragraphs: [
          "Skill-based claims are only meaningful if the random parts are genuinely random and the rules are enforced equally. That is a platform question rather than a design one: randomness is generated server-side, game logic is server-authoritative, and per-game ratings keep results honest over time. The Fair Play Policy documents those commitments, and it is a more useful read than any claim about a game's percentages.",
          "The practical takeaway: stop asking whether a game is 'skill' or 'luck'. Ask which decisions the game lets you make, and whether both players get the same set of them. That question has a useful answer, and the first one does not.",
        ],
      },
    ],
    gameSlugs: [
      "keno",
      "dice-flush",
      "mines-pvp",
      "chess",
      "tic-tac-toe",
      "four-in-a-row",
      "dots-and-boxes",
    ],
    relatedGuides: ["speed-versus-accuracy", "reading-your-opponent"],
  },

  {
    slug: "improve-concentration",
    title: "How to Improve Concentration in Competitive Games",
    metaDescription:
      "Focus techniques for short and long matches: attention residue, pre-match routines, managing notifications, and how to hold concentration when a game runs long.",
    h1: "How to improve concentration during competitive games",
    summary:
      "Concentration is not willpower. It is the absence of competing demands on your attention, which is a condition you can arrange before a match instead of summoning during one. This guide covers how to set that up, and how to hold it once a game runs long.",
    sections: [
      {
        heading: "Attention residue is the real opponent",
        paragraphs: [
          "When you switch from one task to another, part of your attention stays behind for a while. Starting a match immediately after answering a message or closing a dozen tabs means beginning the game with part of your mind elsewhere — and in a match decided by twenty seconds of decision-making, that is most of the game.",
          "Build a gap before you queue. A minute with nothing incoming is enough to let the residue clear, and it is the cheapest concentration improvement available.",
        ],
      },
      {
        heading: "Make your environment boring on purpose",
        paragraphs: [
          "Every notification is a decision you did not choose to make. Silence messages, close unrelated windows, and put the phone out of arm's reach — not face down on the desk, which still pulls at you.",
          "Match your screen brightness and posture to a long sit rather than a quick glance. Fatigue is a concentration problem long before it is a comfort problem; a setup that has you leaning forward by the third match is one you cannot concentrate in.",
        ],
      },
      {
        heading: "Use a short pre-match routine as an anchor",
        paragraphs: [
          "A consistent thirty-second routine before each match — same posture, same screen check, same breath — gives you a reliable cue that the game is starting and the rest of the day is stopped. Routines work because they remove decisions, and this is a decision worth removing.",
          "The routine also helps you notice when you have skipped it, which is often the first sign that you are playing while tired or distracted rather than because you want to.",
        ],
      },
      {
        heading: "Match your focus strategy to the game's clock",
        paragraphs: [
          "Short matches and long ones demand different kinds of attention, and using the wrong one is why players feel sharp in one game and lost in another.",
        ],
        bullets: [
          "Burst games — Rock-Paper-Scissors rounds, a Precision stop, a Speed Typing race — are over before a wandering thought can land. There, the enemy is a slow start and over-thinking; a rehearsed default beats deliberation.",
          "Turn-based games — Chess, Hex Duel, Dots & Boxes, Sudoku Duel — have no clock pressure to keep you anchored, so attention drifts during the opponent's turn. Ritualise the wait: read the board, list two candidate moves, and check the reply to each. Doing this every turn keeps your mind inside the game.",
          "Timed scoring races like Mines Duel are the hardest case, because there is no turn to rest in and the whole match is one continuous decision. Break it into segments — find safe ground, then value the flags you have left — so you always have a next task rather than an open horizon.",
        ],
      },
      {
        heading: "Stop before concentration does",
        paragraphs: [
          "The first sign of fading attention is usually a mistake you can explain afterwards and would not have made an hour earlier. Treat the second such mistake in a session as a stop signal, not as something to push through. Attention you spend recovering is attention you do not have for the next match, and the session you end early is the one you can repeat tomorrow.",
        ],
      },
    ],
    gameSlugs: [
      "rps",
      "precision",
      "speed-typing",
      "chess",
      "hex-duel",
      "sudoku-duel",
      "mines-pvp",
    ],
    relatedGuides: [
      "reaction-time-in-competitive-games",
      "memory-techniques-for-competitive-games",
    ],
  },

  {
    slug: "how-to-practice-competitive-games",
    title: "How to Practice for Competitive Games",
    metaDescription:
      "How to practice deliberately rather than just play more: choosing one skill, using AI practice as a rehearsal room, measuring something real, and avoiding autopilot repetition.",
    h1: "How to practice for competitive games",
    summary:
      "Playing more is not the same as practising. Practice is a loop: choose something narrow, do it under conditions you control, measure whether it worked, and change one variable at a time. Everything below is about running that loop on GRYND.",
    sections: [
      {
        heading: "Separate practice from playing",
        paragraphs: [
          "Ranked matches are a test. They are excellent at telling you where you stand and terrible at letting you work on a specific weakness, because you cannot choose the situation you get.",
          "So keep the two modes distinct. Practice mode is where you isolate a skill; ranked play is where you find out whether it survived contact with an opponent. Mixing them is why so many players feel like they are improving in the practice lobby and stalling in competition.",
          "A useful way to hold the two apart: a practice block is a drill, and a match is a test. Tests tell you where you stand; drills are how you change it. Players who only ever test get slowly better at the game they already have and barely better at the ones they are weak in, because nothing inside a ranked match is designed to be repeated. Decide which one you are doing before you sit down, and the answer tells you whether to open the queue or the practice lobby.",
        ],
      },
      {
        heading: "Pick one variable per practice block",
        paragraphs: [
          "If you change nothing specific, your practice is just more games. Choose a single thing to work on — the first move you make in a turn-based game, the decision to flag or reveal in Mines Duel, the power setting you trust in Mini Golf — and give it your whole attention for the block.",
          "One variable at a time is not pedantry. If you change three things and improve, you have learned nothing about which change helped.",
        ],
      },
      {
        heading: "Use AI practice as a rehearsal room",
        paragraphs: [
          "Bot practice exists in most GRYND games precisely so you can rehearse a situation repeatedly without an opponent's tempo deciding your repetitions. The habit that makes it useful is arriving with a question: 'Can I clear a board without ever guessing?' 'Does my opening hold up when the bot plays the natural reply?'",
          "Then leave with an answer, and go apply it in a ranked match where the result counts. Practice that never gets tested in competition is a hobby; competition with no practice in between is just variance.",
        ],
      },
      {
        heading: "Measure something that actually moves",
        paragraphs: [
          "Ratings are the long-run measure and they move slowly, so they make poor feedback inside a session. Pick a smaller thing you can count per practice block: how often you cleared a puzzle without a wrong note, how many times you committed to a stop early versus late, how many errors you typed per passage.",
          "Small measurements move quickly enough to tell you whether the change is working, which is what keeps practice from feeling like blind repetition. Your per-game Elo rating is where the result eventually shows up, but it is not the instrument you use while drilling.",
        ],
      },
      {
        heading: "Schedule the review, not just the practice",
        paragraphs: [
          "Leave five minutes at the end of a block to write down what changed and what did not. This is the step almost everyone skips, and it is the one that turns a week of sessions into a plan. If you cannot say what you learned, you spent the time playing rather than practising — which is fine, as long as you are honest about which one you intended.",
        ],
      },
    ],
    gameSlugs: ["mines-pvp", "mini-golf", "chess", "speed-typing", "sudoku-duel"],
    relatedGuides: ["building-competitive-habits", "speed-versus-accuracy"],
  },

  {
    slug: "reading-your-opponent",
    title: "How to Read Your Opponent",
    metaDescription:
      "Pattern reading in 1v1 games: tracking habits, punishing predictability, when to break your own pattern, and how hidden-information duels reward inference over instinct.",
    h1: "How to read your opponent",
    summary:
      "In a 1v1 game, your opponent is not a puzzle to solve once — they are a player with habits, and habits are information. Reading them is a learnable skill: watch for repetition, notice when you are being read in turn, and know which games actually reward inference.",
    sections: [
      {
        heading: "Everyone has a pattern, including you",
        paragraphs: [
          "Under time pressure, people default. They open the same way, choose the same safe move, and reach for the same response when surprised. The first step in reading an opponent is accepting that you have a default too — and finding it, because that is the one your opponent is exploiting.",
          "Look at your own last few matches and ask what you did when you had no time to think. Whatever the answer is, it is the thing to vary.",
        ],
      },
      {
        heading: "Rock-Paper-Scissors is a pattern game, not a guessing game",
        paragraphs: [
          "A Rock-Paper-Scissors round resolves on one click, and a match runs to a best-of-seven series — so across seven rounds there is room for habits to show. Players who lose back-to-back rounds tend to switch on a rhythm rather than at random, and players who win tend to keep the choice that worked a round or two too long.",
          "That is the whole game at a competitive level. There is no timing skill to practise and nothing to memorise: you are tracking a person's tendencies and spending your own unpredictability in the right moments. If you notice yourself settling into a comfortable rotation, you have already given the round away.",
        ],
      },
      {
        heading: "Hidden-information games reward inference",
        paragraphs: [
          "Some games hide something from you and ask you to work it out. Odds is built on exactly that: hidden numbers and a shrinking range of possibilities, so every action you take either narrows what your opponent can be holding or gives away what you hold.",
          "The discipline is to slow down where information is cheap. A turn where nothing is revealed is a turn you should spend extracting a constraint, not making a guess you will have to live with. The same logic applies in Key-draw games like Keno, where both seats see the same draw and the player who has tracked what is still live makes faster calls than the one who reacted to each roll in isolation.",
        ],
      },
      {
        heading: "In solved games, plan for the reply, not the move",
        paragraphs: [
          "Turn-based games like Tic-Tac-Toe, Four-in-a-Row and Dots & Boxes do not reward reading a personality so much as reading a position. The habit that wins is treating your opponent's turn as part of your own move: before you commit, work out what they must do in response, and only then decide whether the move is good.",
          "This is where 'reading' stops being about psychology and becomes pure calculation. If your move creates a threat they cannot answer, the choice is right regardless of who is sitting opposite; if it does not, the choice is wrong even against a player you have never faced.",
        ],
      },
      {
        heading: "Break your own pattern at the right moment",
        paragraphs: [
          "Once you are being read, the corrective is to vary — but only where it does not cost you. Deviating from a strong plan just to be unpredictable is a way to lose games to your own cleverness. The rule that works: stay on the best move for as long as it is the best move, and spend your unpredictability on genuine coin-flips, where a predictable choice is the only thing that can cost you.",
        ],
      },
    ],
    gameSlugs: ["rps", "odds", "keno", "tic-tac-toe", "four-in-a-row", "dots-and-boxes"],
    relatedGuides: ["what-makes-a-game-skill-based", "how-to-improve-at-chess"],
  },

  {
    slug: "recovering-from-a-losing-streak",
    title: "How to Recover From a Losing Streak",
    metaDescription:
      "Why losing streaks happen, how per-game ratings separate variance from a real slump, and the concrete steps that stop a bad run turning into a bad session.",
    h1: "How to recover from a losing streak",
    summary:
      "A losing streak feels like evidence about your ability. Usually it is evidence about your last hour: tiredness, tilt, or ordinary variance. Sorting out which one you are in is the entire skill, and it takes less time than queueing for another match.",
    sections: [
      {
        heading: "Know what variance looks like",
        paragraphs: [
          "Any game with a random element produces runs — including runs of losses for players who are improving. A short streak carries very little information about whether you are good, which is why going on tilt to prove the streak wrong is such a bad trade.",
          "Per-game ratings exist to smooth exactly this out. Because each game has its own ladder and moves on results over time, a handful of losses barely moves a rating that hundreds of matches built. The ladder is a long-term instrument; your last three games are noise around it.",
        ],
      },
      {
        heading: "Sort the streak into its three real causes",
        paragraphs: [
          "A losing streak usually has one dominant cause behind it, and the fix is different for each one — which is why 'just play through it' fails as advice.",
        ],
        bullets: [
          "Fatigue. Decision quality drops before you notice it. If the losses are full of mistakes you can explain and would not normally make, stop for the day — this is the most common cause and the easiest to fix.",
          "Tilt. After a frustrating loss you play faster and take worse risks, chasing the result back. The tell is that your play style has changed, not just your results.",
          "A real weakness an opponent class has found. If the losses share a pattern — always the same opening mistake, always losing the same kind of position — that is a lesson, not a streak, and it is worth writing down.",
        ],
      },
      {
        heading: "Take the break, and make it a real one",
        paragraphs: [
          "The standard advice is to stop after two or three losses, and it is standard because it works. Stay at the desk and you will keep playing; stand up, leave the screen for ten minutes, and come back to a different task.",
          "If you want to keep playing, switch modes rather than pushing on. A practice match against the bot in the same game lets you rebuild rhythm with nothing on the line, which is exactly the state you want to return to competition in.",
        ],
      },
      {
        heading: "Reset with a game you are strong at",
        paragraphs: [
          "Confidence is a real performance variable, and the fastest way to rebuild it is to win a game you are genuinely good at. GRYND's per-game ladders make this easy to reason about: results in one game do not move another, so a bad run in a game you are learning does not contaminate the game you are confident in.",
          "The point is not to protect a number. It is to return to a match with the settled attention that good decisions need, rather than the slightly frantic state a losing streak produces.",
        ],
      },
      {
        heading: "Then review one loss, properly",
        paragraphs: [
          "Once you are calm, pick a single loss — not the worst, the most typical — and find the first decision you would change. One loss, one lesson. That is how a streak becomes a study plan instead of a story about your ability that is not even true.",
        ],
      },
    ],
    gameSlugs: ["mines-pvp", "chess", "speed-typing"],
    relatedGuides: ["building-competitive-habits", "how-to-practice-competitive-games"],
  },
];

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
