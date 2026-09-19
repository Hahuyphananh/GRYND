# GRYND | Multiplayer Skill Gaming Platform

Welcome to **GRYND**, a multiplayer skill gaming platform where players compete in fast-paced games using **virtual tokens**.

GRYND combines competitive **PvP matches, AI opponents, classic games, and arcade-style experiences** into one platform, with personalized game recommendations and a responsive experience across desktop and mobile.

---

## Features

* **Multiplayer Games**: Play a growing collection of competitive games including **Poker, Blackjack, Roulette, Chess, Crash, Mines, Towers, Plinko, Keno, Dice Flush, Neon Flush, Rock Paper Scissors**, and more.
* **PvP & AI Gameplay**: Compete against other players in real-time matches or play against AI opponents.
* **Virtual Token System**: Play using virtual tokens designed for competitive, play-for-fun gameplay. Tokens have no real-world monetary value and cannot be redeemed for cash.
* **Competitive Matches**: Head-to-head games, duels, multiplayer tables, match-based gameplay, and competitive scoring.
* **Personalized Game Recommendations**: GRYND learns players' game preferences and provides a personalized **FOR YOU** game section.
* **Live Player Counts**: Game cards display how many players are currently playing each game.
* **Secure Authentication**: Clerk-powered authentication with JWT and OAuth support.
* **Wallet & Token Management**: Secure token balance management through protected API routes.
* **GRYND+**: Optional subscription features and premium platform functionality.
* **Responsive & Mobile-Friendly**: Designed to provide a smooth experience across desktop and mobile devices.
* **Native Mobile Support**: Mobile app functionality through a native Capacitor wrapper.
* **Security First**: Built with protections including SQL injection prevention, CSRF protection, rate limiting, secure authentication, and TLS.
* **Modern Game UI**: Fast, interactive game interfaces with custom GRYND visuals and animations.

---

## Games

GRYND currently includes a growing collection of skill-based and arcade-style games:

| Game                    | Gameplay                                 |
| ----------------------- | ---------------------------------------- |
| **Poker**               | Multiplayer No-Limit Texas Hold'em       |
| **Blackjack**           | Competitive best-of-3 Blackjack          |
| **Roulette**            | Head-to-head Roulette PvP                |
| **Mines**               | Mines PvP and AI gameplay                |
| **Crash**               | Timing-based multiplier game             |
| **Towers**              | Stack and balance your way to the top    |
| **Plinko**              | Physics-based Plinko gameplay            |
| **Chess**               | Chess against AI or real players         |
| **Keno**                | Keno and Keno Catch competitive gameplay |
| **Dice Flush**          | Yahtzee-style dice gameplay              |
| **Neon Flush**          | UNO-style multiplayer card game          |
| **Rock Paper Scissors** | Best-of-7 competitive matches            |

New games and modes are continuously being added to the platform.

---

## Preview

![GRYND banner](./public/og-image.png)

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

GRYND is built around **competitive skill gaming** — giving players a single platform to discover games, challenge opponents, compete against AI, and find games tailored to their preferences.

GRYND uses **virtual tokens only**. Tokens have no real-world monetary value and are not redeemable for cash.

**GRYND is an 18+ platform and promotes responsible play.**
