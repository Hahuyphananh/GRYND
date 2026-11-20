# Play Store listing copy

Ready-to-paste text for Google Play Console → **Store listing**. Keep this in
step with the product: a description promising something the app does not do is
a policy problem, not just a marketing one.

Limits (Play Console enforces them): app name ≤ 30, short description ≤ 80, full
description ≤ 4000 characters.

---

## App name (30 max)

```
GRYND
```

## Short description (80 max)

```
Klondike Solitaire, one deck, two players. Free ranked ladder.
```

_72 characters._

## Full description (4000 max)

```
GRYND is competitive Klondike Solitaire. One deal, two players, a free ranked
ladder — and results the server verifies, so nobody argues with the scoreboard.

ONE DEAL, TWO PLAYERS
Every ranked match starts from a deal the server generates and gives to both
seats. Same cards, same order, same clock. Nobody gets a luckier deal, and
nobody can re-roll one.

SIX WAYS TO PLAY
• Ranked — race a real person on the same deal for Elo and trophies
• Solo — play the classic game alone, with undo and a personal timer
• Vs AI — six opponents, from a relaxed beginner to a bot that does not miss
• Daily challenge — one deal for everyone, fixed by the UTC date
• Daily puzzle — three verified positions from one deal, one mistake ends it
• Unlimited puzzles — practise single positions for as long as you like

SERVER-AUTHORITATIVE BY DESIGN
Every move, the clock, your progress and the result are validated and held by
the server. The browser never decides a match. Your rating, trophies and
statistics come from settled results, not from what the app claims.

TRACK YOUR CLIMB
Full statistics per mode, an Elo ladder, trophies, streaks, and match history
you can revisit move by move — including a game review that replays your own
decisions.

GRYND ACADEMY
A structured course, short videos and drills that teach the openings, the
midgame and the endgame of Klondike — free.

FAIR AND TRANSPARENT
Coins are virtual credits with no cash value and cannot be exchanged for money.
Ranked solitaire costs nothing to play: no stake, no entry fee. GRYND is an 18+
platform and verifies age at sign-up.

Advertising is disabled inside the app.

Made for phones: GRYND runs on Android with system back-button support, safe
areas on every screen shape, haptics and keyboard-aware layouts.
```

## What's new (release notes, 500 max per language)

```
First Android release. Ranked Klondike Solitaire, daily challenge, six bot
opponents, and the GRYND Academy — all server-verified.
```

## Reviewer notes (App access / "Notes for reviewers")

Play asks two things that decide whether this app is reviewed or rejected: how
to get in, and whether it is more than a website.

**App access — provide working credentials.** GRYND requires an account, and a
reviewer who hits a sign-in wall sees nothing to review.

```
The app requires an account. Use these credentials:

  email:    <FILL IN a dedicated reviewer account>
  password: <FILL IN>

The account is pre-verified 18+ and has no payment method. From the home
screen, "Play ranked" and "Practice vs AI" both open a full game; "Daily
challenge" starts today's deal. No purchase is needed to test any feature.
```

**Notes for reviewers — the native-integration case.**

```
GRYND is a native Android app whose UI is rendered by our service, the same
way a streaming or commerce app does. It is not a repackaged website:

• The app identifies itself to our server (a User-Agent token) and receives a
  different build of the experience: in-app purchases and web advertising are
  disabled inside the app by design, so nothing is sold or served through a
  channel Play does not support.
• Android system back button is handled natively to navigate the game, not to
  close the app.
• Window insets are handled for edge-to-edge Android 15+ display: safe areas and
  the on-screen keyboard are respected on every screen.
• Haptic feedback, the splash screen and the status bar are native plugins.
• A local offline recovery page replaces the platform error screen when the
  device has no connection, with a retry action.
• The app requests only the INTERNET permission.

Coins shown in the app are virtual credits with no cash value; they cannot be
purchased inside the app and cannot be redeemed for money.
```

## Category, tag and contact

| Field                | Value                                         |
| -------------------- | --------------------------------------------- |
| Category             | Games → Card                                  |
| Tags                 | Solitaire, Card game, Strategy                |
| Contact email        | support address used on `/contact`            |
| Website              | `https://www.grynd.dedyn.io`                  |
| Privacy policy       | `https://www.grynd.dedyn.io/privacy-policy`   |
| Account deletion URL | `https://www.grynd.dedyn.io/account-deletion` |

## Graphic assets

| Asset             | File                             | Size            |
| ----------------- | -------------------------------- | --------------- |
| App icon          | `public/icon-512.png`            | 512 × 512       |
| Feature graphic   | `play-store/feature-graphic.jpg` | 1024 × 500      |
| Phone screenshots | `play-store/screenshots/*.jpg`   | 1080 × 1920 (5) |

Regenerate the last two with `npm run assets:play-store` (see
`play-store/README.md`).
