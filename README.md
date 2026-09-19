# GRYND | Multiplayer Skill Gaming Platform

Welcome to **GRYND**, a multiplayer skill gaming platform where players compete in fast-paced games using **virtual tokens**.

GRYND brings competitive PvP games, multiplayer experiences, AI opponents, strategy games, arcade-style challenges, and classic games together on one platform. Players can discover games based on their preferences and compete across desktop and mobile.

---

## Features

* **20 Games**: A growing collection of competitive, strategy, arcade, and classic games.
* **PvP Gameplay**: Compete against other players in real-time head-to-head and multiplayer matches.
* **AI Opponents**: Play supported games against AI opponents for practice.
* **Virtual Token System**: Play using virtual tokens. Tokens have no real-world monetary value and cannot be redeemed for cash.
* **Competitive Matches**: Compete in duels, multiplayer tables, races, strategy matches, and skill-based challenges.
* **Personalized Game Recommendations**: GRYND uses a game-preference questionnaire to create a personalized **FOR YOU** section.
* **Live Player Counts**: Game cards show how many players are currently playing each game.
* **Player Progression**: Track gameplay, wins, streaks, rankings, and other player statistics.
* **Secure Authentication**: Clerk-powered authentication with JWT and OAuth support.
* **Wallet & Token Management**: Secure token balance management through protected API routes.
* **GRYND+**: Optional subscription features and premium platform functionality.
* **Responsive Design**: Optimized for desktop and mobile gameplay.
* **Native Mobile Support**: Mobile app functionality through Capacitor.
* **Security First**: Built with protections including SQL injection prevention, CSRF protection, rate limiting, secure authentication, and TLS.
* **Modern Game Experiences**: Interactive interfaces, animations, game effects, and custom GRYND visuals.

---

## Games

GRYND currently features 20 games:

| Game                    | Type                                          |
| ----------------------- | --------------------------------------------- |
| **Roulette**            | Fast-paced PvP wheel duel                     |
| **Blackjack**           | Strategic head-to-head card game              |
| **Mines**               | Risk-based PvP tile game                      |
| **Memory Grid**         | Memory and pattern-recall duel                |
| **Plinko**              | Physics-based PvP ball-drop game              |
| **Poker**               | Multiplayer No-Limit Texas Hold'em            |
| **Crash**               | Multiplayer crash and cash-out game           |
| **Chess**               | Strategic PvP and AI chess                    |
| **Keno**                | Fast-paced number and reaction game           |
| **UNO**                 | Multiplayer card game                         |
| **Rock Paper Scissors** | Best-of-7 PvP duel                            |
| **Tower Arena**         | Multiplayer physics-based tower-stacking game |
| **Four in a Row**       | Strategic Connect Four-style duel             |
| **Lane Rush Duel**      | Competitive tower-climbing PvP race           |
| **Pool Masters**        | Physics-based 8-ball pool                     |
| **Hex Duel**            | Turn-based hex-grid strategy game             |
| **Dice Flush**          | Yahtzee-style dice strategy game              |
| **Odds**                | Prediction and mind-game duel                 |
| **Precision**           | Fast-paced reaction and timing duel           |
| **Dots & Boxes**        | Classic territory and strategy game           |

Each game has its own gameplay mechanics and competitive format, ranging from fast reaction challenges to strategic board games and multiplayer table games.

---

## Personalization

GRYND includes a personalized game discovery system designed to help players find games that match their preferences.

During onboarding, players can answer questions about the types of games they enjoy, their experience level, motivations, and preferred gameplay styles.

GRYND uses these preferences to generate a personalized **FOR YOU** game section while keeping the complete game catalog available through **All Games**.

Players can also update their preferences later through Settings.

---

## Preview

![GRYND banner](src/image/bannerimage.png)

*GRYND platform banner*

---

## Tech Stack

| Layer              | Technology                             |
| ------------------ | -------------------------------------- |
| **Frontend**       | Next.js 16.15, React 19.1, TailwindCSS |
| **Backend**        | Next.js API Routes                     |
| **Database**       | Neon Postgres                          |
| **ORM**            | Drizzle ORM                            |
| **Authentication** | Clerk (JWT + OAuth)                    |
| **Hosting**        | Vercel                                 |
| **Mobile**         | Capacitor                              |

---

## Environment Setup

1. Copy `.env.example` to `.env.local`.
2. Fill in all required environment variables.
3. Never commit `.env.local` or production secrets.
4. If secrets have previously been exposed, rotate them immediately in the relevant provider dashboards.

### Resend Email Webhooks

GRYND supports Resend email webhooks through:

`/api/webhooks/resend`

Configure Resend to send inbound `email.received` events and outbound events such as:

* `email.sent`
* `email.delivered`
* `email.bounced`
* `email.failed`

Set the following environment variables:

* `RESEND_API_KEY`
* `RESEND_WEBHOOK_SECRET`

See `docs/resend-webhooks.md` for the complete webhook configuration checklist.

---

## About GRYND

GRYND is built around competitive skill gaming, giving players a single platform to discover games, challenge opponents, practice against AI, compete in multiplayer matches, and find games tailored to their preferences.

GRYND uses **virtual tokens only**. Tokens have no real-world monetary value and are not redeemable for cash.

**GRYND is an 18+ platform and promotes responsible play.**
