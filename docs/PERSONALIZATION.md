# GRYND personalization (v1): the recommendation engine

How a player's onboarding questionnaire answers turn into a game order.

- Engine: `src/lib/gameRecommendations.js`
- Game/tag catalog: `src/lib/gameTags.js`
- API: `GET /api/onboarding/recommendations`
- Tests: `npm run test:recommendations` (`tests/game-recommendations.test.mjs`)

There is **no machine learning** here. No model, no training data, no
randomness, no network call. The engine is a pure function: the same answers
always produce the same order, and every score can be read back as a list of
reasons (`game_type:strategy`, `priority:ranking_up`, …).

Personalization **reorders**. It never hides, locks, filters or shortens the
lobby — every game is returned, every time, and "All Games" is untouched.

---

## 0. The surfaces, end to end

| Surface | What it does |
|---|---|
| `/welcome/questionnaire` | The five questions. **First run** (new account, or an existing player who never answered) or **edit mode** (answers already saved) decide only the copy and the exit: edit mode shows an *Editing your preferences* badge, a **Save changes** button and a **Cancel** that writes nothing. Saving PUTs a replacement. |
| Welcome tutorial (`/welcome`) | Unchanged, plus ONE warm follow-up line on the hand-off from the questionnaire (`welcomeMessageKey`, §5.2). |
| Casino lobby (`/casino`) | The **FOR YOU** strip (§6), for personalized + complete profiles only. |
| Settings (`/settings`) | **Your GRYND Preferences** — reads the saved answers through the same API and links into the same flow (`?from=settings`, returning to Settings). The permanent entry point for anyone who chose "Maybe Later". |

One store, one catalog, one API: `onboarding_responses` ← `src/lib/onboardingQuestionnaire.js` ← `/api/onboarding/questionnaire`.

## 1. Inputs

The five questionnaire questions (`src/lib/onboardingQuestionnaire.js`), of
which four feed the engine:

| Question | Key | Used for ranking? |
|---|---|---|
| What brings you to GRYND? | `motivation` | yes (supporting signal) |
| What types of games do you like? | `game_types` | **yes (primary signal)** |
| How experienced are you? | `experience` | lightly + messaging |
| What matters most to you? | `priorities` | yes (supporting signal) |
| How did you discover GRYND? | `discovery` | **no — analytics only** |

Answers are normalized first (`normalizePreferences`): unknown keys and unknown
option values are dropped, and values are returned in questionnaire catalog
order, so "the primary goal" is stable regardless of the order the player
clicked. Missing, partial, empty or malformed answers are all acceptable.

## 2. Tags

Each game carries traits from a fixed vocabulary in `src/lib/gameTags.js`:

| Tag | Meaning |
|---|---|
| `pvp` | head-to-head 1v1 duel |
| `multiplayer` | 3–6 player shared table |
| `strategy` | the match turns on planning / reading the opponent |
| `fast_paced` | short rounds decided by timing, reflexes or a quick sequence |
| `casual` | shallow learning curve — jump in and play |
| `chance` | randomness does most of the work; the player manages it |
| `competitive` | positioned around rank/stake climbing rather than a pick-up game |
| `skill` | the outcome turns primarily on player ability |

`pvp` / `multiplayer` are not opinions — a test reads the casino lobby's
`games` array and asserts the tags match `pvpMode` one-for-one, and that the
catalog's ids, hrefs and **order** equal the lobby's. The other six are
hand-assigned from each game's shipped description:

| Game | Tags | Why |
|---|---|---|
| Roulette | pvp, chance, fast_paced | decided by the spin; quick shared-wheel rounds |
| Blackjack | pvp, strategy, skill | "read the table, time your swaps", best-of-3 |
| Mines Duel | pvp, chance, competitive | hidden mines are luck; the staked duel is the core |
| Memory Grid | pvp, skill, casual | memory is ability; rules take seconds |
| Plinko | pvp, chance, fast_paced | the drop is chance; 3 balls each, quick |
| Crash Arena | multiplayer, chance, fast_paced, competitive | random crash curve, last standing |
| Chess | pvp, strategy, skill, competitive | "outthink your opponent move by move" |
| Keno | pvp, chance, fast_paced, casual | same draw for both; timed taps; no teaching needed |
| Neon Flush (UNO) | pvp, fast_paced, casual | fast card duels, instantly readable |
| Rock-Paper-Scissors | pvp, fast_paced, casual | best-of-7 mind games, one click per round |
| Tower Arena | multiplayer, strategy, skill, competitive | placement planning + collapse risk, 2–6 players |
| Four-In-A-Row | pvp, strategy, skill | pure alignment planning |
| Lane Rush Duel | pvp, skill, competitive, fast_paced | climb-and-bank reads; staked race |
| Pool Masters | pvp, skill, strategy | aiming + table planning |
| HEX DUEL | pvp, strategy, skill, competitive | territory conquest on the ladder |
| Dice Flush | pvp, chance, strategy | dice rolls, then combo locking |
| Odds | pvp, strategy, skill | hidden numbers, shrinking range |
| Precision | pvp, skill, fast_paced, competitive | reaction-timing staked duel |
| Dots & Boxes | pvp, strategy, skill | pencil-and-paper planning |

Two invariants the tests enforce: every tag is used by at least one game, and
no game is tagged both `chance` and `skill` (a game decided by luck is not also
decided by ability).

## 3. Weights

Every game starts at 0 and gains a weight per matching signal
(`RECOMMENDATION_WEIGHTS`):

| Source | Weight | Mapping |
|---|---|---|
| Q2 `game_types` | **10** each | `pvp_duels`→pvp, `strategy`→strategy, `fast_paced`→fast_paced, `casual`→casual, `luck_chance`→chance, `competitive`→competitive |
| Q1 `motivation` | 4 each | `competition`→competitive, `versus_players`→pvp, `fun`→casual, `rewards`→token-wager support |
| Q4 `priorities` | 4 each | `winning`→skill, `ranking_up`→competitive, `improving_skills`→skill, `fun`→casual, `earning_tokens`→token-wager support |
| Q3 `experience` | 2 | `new`→casual, `experienced`/`highly_competitive`→competitive, `casual`→none |

Signals **stack**: two answers can reward the same tag and each contributes its
own weight and its own reason string.

Two deliberate non-signals:

- `motivation: variety` ("playing different games") is a preference for
  *breadth*, which every game satisfies, so it is order-neutral and produces no
  signal at all.
- `discovery` never reaches the ranking. It is stored for analytics/marketing.

"Token-wager support" is not a hand tag: it is read from the real catalog in
`src/lib/defaultWagers.js`, so adding a wager to a game automatically feeds the
engine.

### Ordering

Score descending, **ties broken by the lobby's featured order**. That one rule
produces the required backwards-compatible fallback for free.

## 4. Fallbacks

| Situation | Result |
|---|---|
| No questionnaire (`null`) — existing accounts | default lobby order, `personalized: false` |
| Skipped / dismissed | default lobby order, `personalized: false` |
| Empty or partial answers | only the matched games move; everything else keeps its relative order |
| Unknown values / wrong types / junk | dropped; if nothing usable remains → default order |
| Only `variety`, only `discovery` | no signal → default order |

Nothing in the fallback path throws, and no fallback is ever "no games".

## 5. Output

`recommendGames(answers)` returns a JSON-safe payload:

```js
{
  personalized: true,                 // false ⇒ this IS the default lobby order
  complete: true,                     // every question answered (see §5.1)
  source: "questionnaire",            // or "default"
  preferences: { game_types: [...], motivation: [...], priorities: [...], experience: "…" },
  recommendations: [                  // ALL games, ranked
    { id, href, tags, score, reasons: ["game_type:strategy", …] }
  ],
  primaryGameIds: ["chess", "hex-duel", "…"],   // first 3 = "primary suggestions"
  messageKey: "onboarding.personalization.goals.ranking_up",          // or null
  experienceMessageKey: "onboarding.personalization.experience.new",  // or null
}
```

### 5.1 Completeness

`complete` means the answer set is a full questionnaire submission (every
question in the catalog answered with a valid value), checked against the raw
answers with the same rule `PUT/POST /api/onboarding/questionnaire` enforces.

Ranking *partial* answers is supported and tested, but a half-answered
questionnaire is not a stated preference: any surface that shows a personalized
section must require **`personalized && complete`**. The game order is still
usable for partial answers — the flag only gates the "For You" UI.

### 5.2 The post-questionnaire line

`welcomeMessageKey(answers)` picks exactly ONE line for the first step of the
welcome tutorial, only when the player arrives from the questionnaire and only
for a complete answer set. First match wins:

| Rule | Line (en) |
|---|---|
| `earning_tokens` goal, or `rewards` motivation | "Let's find some games you'll enjoy." |
| `experienced` / `highly_competitive` | "Let's get you into the action." |
| `casual` | "Let's start with something you'll enjoy." |
| `new` | "Let's get you comfortable with GRYND." |

One warm line, no name and no stats — nothing that reads as profiling — and
`null` for everybody else, so the hero is byte-identical for replays and
returning players.

`messageKey` is the player's **primary goal** (Q4, first in catalog order);
`experienceMessageKey` is the **experience tier** (Q3). Both are translation
keys under `onboarding.personalization.*` (en/fr/es) — never literal English —
so the UI can localize without knowing anything about scoring. Experience is
intentionally the lightest ranking weight; its main job is to pick the tone of
the follow-up message, and it never affects availability.

## 6. Where it appears: the casino lobby

`src/app/casino/PageClient.jsx` renders a **FOR YOU** section between the
search/filter controls and the existing **All Games** grid (above "Recently
played"). It shows the engine's `primaryGameIds` — the top 3 — using the
*lobby's own* `GameCard`, with an extra "Recommended" pill on the card image.

| Concern | Behaviour |
|---|---|
| Who sees it | signed-in players whose answers are `personalized && complete` |
| Requests | **zero** extra for anyone who never answered the questionnaire (the existing `/api/onboarding/status` snapshot gates it), otherwise **one** `GET /api/onboarding/recommendations` per mount — the payload is the whole ranking, so no per-card requests |
| Ordering | score-based, top 3; it never touches the All Games ordering |
| All Games | unchanged, below the section, with every filter + sort |
| Filters/search | the section hides as soon as the player searches or picks a filter — the same rule the "Recently played" strip uses, so the grid is never competing with a personal pick |
| Fallbacks | logged out, no questionnaire, partial answers, API error, `personalized: false`, or an id that doesn't resolve to a lobby game → the section simply doesn't render, and the lobby is exactly what it was before |
| Copy | `FOR_YOU_MESSAGE_KEY` ("For you"), the player's goal message (`messageKey`), else `FOR_YOU_HINT_MESSAGE_KEY`, plus `home.casino_lobby.recommended_badge` — all localized (en/fr/es) |
| After an edit | the section re-reads on the next mount, and again whenever the tab becomes visible, so changing answers in Settings and coming back shows the new picks (the visibility watcher fires no request of its own) |

Nothing is hidden: the section is additive, and a player without personalization
sees precisely the pre-existing lobby.

Verify the layout in real Chrome (mobile → wide, plus a no-section control):

```bash
npm run verify:lobby-for-you   # qa/lobby-for-you-check.mjs
```

It asserts no horizontal overflow and no element escaping the viewport at
375/390/768/1024/1280/1536, that the For You cards are exactly as wide as the
All Games cards at every breakpoint, that the grid collapses 1 → 2 → 3 columns,
and that the "Recommended" pill neither overflows the card art nor collides
with the PvP / NEW / HOT badges.

## 7. API

`GET /api/onboarding/recommendations` → the payload above, for the
**authenticated Clerk user**.

- No user-id parameter exists — not in the query string, not in the body. The
  row is selected by the session's `clerkId`, so nobody can request another
  player's preferences. The route reads no request input at all.
- Signed-out callers get the default order (`personalized: false`); no user row
  is looked up, so nothing private is exposed and the public lobby keeps
  working.
- Query cost: **one** query for a player who never answered the questionnaire
  (the user row decides), two only once they have.

## 8. Editing preferences later

Settings → **Your GRYND Preferences** (`src/app/settings/PageClient.jsx`) reads
`GET /api/onboarding/questionnaire` once per mount, renders the saved answers as
localized chips (built from the same catalog + label keys the flow uses) and
links to `/welcome/questionnaire?from=settings`. That flow detects
`completed === true` and becomes **edit mode**: prefilled, "Editing your
preferences" badge, **Save changes**, and a **Cancel** that writes nothing.
Saving replaces the rows atomically, so there is never a duplicate answer set,
and `questionnaire_completed_at` keeps its original timestamp.

A player who chose "Maybe Later" sees the same card with a **Set up my
preferences** CTA — dismissing the invitation never removes the way back in.

## 9. Extending it

- **New game**: add it to the lobby's `games` array and to `GAME_CATALOG` in the
  same position, with tags. The tests fail until both halves exist.
- **New questionnaire option**: add it to the catalog and wire it in
  `GAME_TYPE_SIGNALS` / `PRIORITY_SIGNALS` / `EXPERIENCE_SIGNALS`, or the
  "every option is wired up or documented as analytics-only" test fails.
- **Retuning**: edit `RECOMMENDATION_WEIGHTS` only — nothing else hardcodes a
  number.
