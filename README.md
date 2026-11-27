# GRYND — Competitive Solitaire

GRYND is a competitive **Klondike Solitaire** platform. Two players get the same
server-dealt puzzle and race to solve it; the first to move all 52 cards to the
foundations wins. Ranked results move a server-verified Elo rating and trophies.
Nothing is wagered and there are no purchasable tokens.

GRYND is 18+ and built around fair, transparent competition: the deal is
identical for both seats, the rules are enforced server-side, and every result is
replayable.

---

## How you play

| Mode | What it is | Rated |
| --- | --- | --- |
| **Ranked** | A 1v1 race on the same deal against a live player. Free to enter. | Yes — Elo + trophies |
| **Solo** | Klondike on your own, timed, with a saved record. | No |
| **Daily Challenge** | One full deal per UTC day, identical for every player. | No |
| **Practice vs AI** | Six bot opponents, from Rookie to Perfect. | No |
| **Puzzles** | Daily and unlimited Solitaire puzzle sets, plus a ranked puzzle queue. | Ranked puzzles are rated separately |

Ranked pairings prefer a live player. If no one is waiting when the queue window
expires, the same deal is raced against a **recorded run** by a real player — a
replay of that person's own moves, never an AI pretending to be a human. Every
surface labels the opponent as **Live player**, **Recorded opponent** or
**GRYND AI**; the classification comes from the server's match data, never from a
display name. Bots are always unrated and never affect a competitive record.

---

## Game Review

Completed games store the deal and the accepted move log, so Game Review can
replay any position from the real log:

- moves are rated only when the engine can compare them with a concrete
  alternative on that board — routine placements and stock passes are not
  narrated;
- flagged moves can show the better move, the measurable reason, and a read-only
  before/after demonstration;
- a mistake links to an existing Academy lesson and a validated practice drill,
  then returns to the same ply;
- the review never reveals a face-down card and never analyses a game the player
  did not finish.

Analysis is cached per game + log + engine version. Re-opening a game is free; a
free account gets a fixed number of fresh analyses per day, and PRO raises that
limit.

---

## Fair play and identity

- One deterministic deal per match, generated server-side from a committed seed,
  solvable, and never pre-solved.
- The server decides the result, the rating change and the trophy change;
  settlement is idempotent per match.
- Opponent type is classified on the server (`human`, `recorded`, `ai`) and
  labelled consistently in the lobby, match view, result screen and analytics.
- No fake player counts, fake online indicators or invented testimonials.

---

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js, React, TailwindCSS |
| Backend | Next.js API routes |
| Database | Postgres (Drizzle ORM) |
| Auth | Clerk |
| Realtime | Socket.IO |
| Analytics | PostHog |
| Mobile | Capacitor |

---

## Environment setup

1. Copy `.env.example` to `.env.local`.
2. Fill in the required variables (database, Clerk, PostHog, and the email
   provider used for transactional mail).
3. Never commit `.env.local` or production secrets. Rotate anything that has
   been exposed.

### Resend email webhooks

GRYND receives Resend events at `/api/webhooks/resend`
(`email.sent`, `email.delivered`, `email.bounced`, `email.failed`,
`email.received`). Set `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`; the full
checklist is in `docs/resend-webhooks.md`.

---

## Repository notes

- `public/llms.txt` is the machine-readable summary of the same product.
- `src/lib/seo.ts` owns page titles, canonicals and social cards;
  `src/lib/seoPages.ts` is the sitemap inventory.
- `src/lib/attribution.ts` stores the first-touch acquisition channel in the
  browser; later tagged visits never overwrite it.
- Shared tests: `npm test`, `npm run typecheck`, `npm run build`.

**GRYND is an 18+ platform and promotes responsible play.**
