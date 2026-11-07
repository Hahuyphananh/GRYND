# Exporting GRYND games to external portals

Status: **tooling + decision record.** The per-game export artifacts can be
generated today (`npm run portal:export`), the chrome-free surface they point at
exists (`/play/<gameKey>`), and it is framable by the portal allowlist. The
CrazyGames SDK v3 bridge is wired. What remains is listed in §5; nothing here
claims a portal approval or a completed submission.

---

## 1. The hard constraint: these games are server-side

Every GRYND game is server-authoritative. Board state lives in Postgres, moves
are validated by API routes, and multiplayer rides Socket.IO. There is no
"zip the game files" export that would work on its own: a static bundle would
contain no rules, no bot and no saved guest progress.

So a portal export is **a playable URL plus a launcher page that frames it**.
That is a supported shape on two of the three target portals:

| Portal | Hosting | SDK required **in the game** | Framing us required | Verdict |
|---|---|---|---|---|
| **itch.io** | zip **or** external embed | none | `https://html.itch.zone` | ✅ start here |
| **CrazyGames** | zip **or** externally hosted iframe | SDK v3 (`init`, `gameplayStart/Stop`, ads) | `*.crazygames.com` | ✅ feasible, needs SDK |
| **Poki** | upload only (Poki hosts the build) | Poki SDK (`init`, `gameLoadingFinished`, `gameplayStart/Stop`, `commercialBreak`) | none — nothing frames us | ⛔ not this app |

**Poki** blocks external requests by default, requires a self-contained web
build under ~8 MB with a 16:9 canvas, forbids external account systems and
personal data, needs a privacy statement, and is hand-curated with limited
access. A Poki submission means porting one game into a standalone build with
the Poki SDK inside it — a separate project, not an export flag. Note also
Poki's **web exclusivity** term: a game published on Poki is expected to be on
Poki only for the open web, which directly conflicts with running the same game
on itch.io and CrazyGames.

**Recommended order:**

1. **itch.io** — no SDK, accepts an external embed, fastest way to see whether a
   portal audience converts. Also the only one where the post-match guest CTA
   (Phase 5) can be tested in the wild.
2. **CrazyGames** — submit the same game as *externally hosted (iframe)*. Needs
   the SDK v3 bridge inside the game for ads/analytics and the frame-ancestors
   change. Largest realistic audience of the three.
3. **Poki** — only if you decide one game is worth porting standalone *and* you
   are prepared to keep it web-exclusive.

Other candidates in the same category, in the same "hosted build or iframe"
family — all need their own requirement review before anything is published,
and none are verified here: **GameDistribution**, **GameMonetize**, **Newgrounds**,
**Y8**, **Lagged**, **Playhop**, **Silvergames**. They generalise as "the same URL,
different SDK/review", so the work in §5 is reusable for them.

---

## 2. What can be exported

`src/lib/portal/catalog.ts` is the single source of truth. It is deliberately
closed to the games a **signed-out visitor can actually play** — the guest
practice games whose results are persisted, plus any game whose practice mode
accepts a guest even though it writes no guest progress:

| Game key | Game | Portal route | App route |
|---|---|---|---|
| `tic-tac-toe` | Ultimate Tic-Tac-Toe | `/play/tic-tac-toe` | `/casino/tic-tac-toe` |
| `dominoes` | Dominoes | `/play/dominoes` | `/casino/dominoes` |
| `battleship` | Battleship | `/play/battleship` | `/casino/battleship` |
| `odds` | Odds | `/play/odds` | `/casino/odds` |
| `solitaire-duel` | Solitaire Duel | `/play/solitaire-duel` | `/casino/solitaire-duel` |

The **portal surface** (`/play/<gameKey>`) is what an export points at: the
game's own screen with none of the site around it. The app route is the same
game with the site chrome. Both render one component — `src/app/casino/<game>/
PageClient.tsx` — so a portal build cannot drift from the app's game.

A portal player has no GRYND account and typically cannot sign in inside a
third-party iframe, so a game that requires an account is not exportable.
`tests/portal-export.test.mjs` enforces the list in two directions: every
`GUEST_PRACTICE_GAME_KEYS` entry must be present, and a game outside that list
(dogfood: `solitaire-duel`) must have a `create-ai` route that goes through
`requirePracticePlayer({ create: true })` — the test reads the endpoint, so a
game cannot be added on a claim alone.

Exported play is **unrated practice**: no Elo, trophies, coins, quests or
account stats are involved, exactly as in the app.

---

## 3. Generating an export

```bash
# One game for one portal
npm run portal:export -- --game dominoes --portal itch --base-url https://www.grynd.example

# Everything, for every portal
npm run portal:export -- --all --base-url https://www.grynd.example

# Repeatable per portal
npm run portal:export -- --all --portal crazygames --portal itch --base-url https://www.grynd.example

# Preview without writing
npm run portal:export -- --all --base-url https://www.grynd.example --dry-run
```

Output is `<out>/<portal>/<gameKey>/` (default `portal-exports/`, git-ignored
by convention — regenerate it per release):

```
portal-exports/itch/dominoes/index.html      # full-viewport launcher
portal-exports/itch/dominoes/manifest.json   # what the submission form wants
```

`index.html` frames the game URL, `allow="fullscreen; autoplay; gamepad"`, and
carries `noindex`. It deliberately contains **no SDK script**: the portal SDK is
called by the game inside its own document, and a wrapper frame cannot drive
another origin's SDK. `manifest.json` records the portal, the hosting shape, the
game, the exact URL, the SDK the game itself still needs, the `frame-ancestors`
entries the host must allow, and the portal's own requirements.

The CLI fails closed: http or malformed base URL, unknown game, unknown portal,
or "no game and no `--all`" all exit `2` without writing anything. There is no
wildcard or `--force`.

---

## 4. Submitting

### itch.io

1. `npm run portal:export -- --game <key> --portal itch --base-url <origin>`
2. New project → **HTML** → upload a zip **containing the files of**
   `portal-exports/itch/<key>/` (not the folder itself).
3. Viewport: set the embed size to fill (the launcher fills 100% of its frame).
4. Cover image, 3–5 screenshots, tags and a description are required by the form.
5. Alternative: **Embed from external site** with the `manifest.url` value — no
   upload, but then the game URL must be framable by `html.itch.zone` (§5.1).

### CrazyGames

1. Create a game in the Developer Portal, engine: **Externally hosted (iframe)**.
2. Submit `manifest.url`.
3. The game must integrate SDK v3 (`window.CrazyGames.SDK`) — see §5.2.
4. Framing: allow `https://*.crazygames.com` (§5.1).
5. Requirements to design for: land directly in gameplay (no lobby wall),
   mobile support, PEGI 12 content, no external ads, and no external login
   options — guest practice fits all of these.
6. Externally hosted games earn only with the SDK integrated.

### Poki

Not a submission path for this codebase (§1). If it becomes one: build a
standalone port of the chosen game with the Poki SDK inside it, keep the initial
download under 8 MB, provide the privacy statement for the multiplayer/backend
calls, and apply through Poki for Developers.

What that port would actually take — candidate game, work breakdown, effort and
the constraints it must satisfy — is assessed in
[`poki-standalone-build.md`](./poki-standalone-build.md). It is not implemented.

---

## 5. What still has to change in this repo

What is left between "generated artifacts" and "portal-accepted build". Items
5.1–5.3 are now implemented and covered by `tests/portal-surface.test.mjs`;
5.4 and 5.5 are not.

### 5.1 Framing policy — **done**

`src/lib/portal/framing.ts` is the policy, wired into `src/proxy.ts` for
`/play/<exported game>` only. It has its own variable — the platform allowlist is
never reused — and the browser gets `frame-ancestors` instead of `X-Frame-Options`:

```
GRYND_PORTAL_FRAME_ORIGINS="https://itch.io,https://html.itch.zone,https://*.crazygames.com"
```

Rules: https only; a bare origin (no path, query, fragment, port or credentials);
and exactly one wildcard shape, `https://*.example.com` — leftmost label only,
over a real registrable domain. `*`, `https://*`, `https://*.com`,
`https://foo.*.com` and IP literals are rejected. With nothing configured (or
nothing valid) `/play` keeps `frame-ancestors 'self'` and stays unframable, so a
missing env var cannot open the surface.

### 5.2 CrazyGames SDK bridge — **done for CrazyGames; Poki not started**

`src/lib/portal/crazygames.ts` (pure) + `src/components/portal/PortalSdkBridge.tsx`
(client, mounted by `/play/<gameKey>`):

- detects a CrazyGames visit from `?portal=crazygames` or a crazygames.com
  referrer — and loads nothing otherwise, so the app and itch.io frames are
  untouched;
- loads the v3 bundle, `init()`s once, waits for it, and attaches only then;
- `gameplayStart()` on the player's first input, `gameplayStop()` when a match
  finishes (both end-of-match surfaces dispatch `grynd:portal-match-finished`),
  on a hidden tab, and on `pagehide`;
- requests one `midgame` ad after play stops, never during play and never twice
  within 60 s;
- treats a missing, incomplete, throwing or blocked SDK as a no-op — a portal
  visit with a broken SDK plays exactly like a normal one.

**Poki is not implemented.** Its SDK is a different contract
(`PokiSDK.init`, `gameLoadingFinished`, `gameplayStart/Stop`, `commercialBreak`)
and it only matters for a Poki build, which this app cannot produce yet (§1).

### 5.3 Chrome-free entry point — **done**

`src/app/play/[gameKey]` renders the game's own `PageClient`, and the site
chrome is gated by pathname in one place, `src/components/SiteChrome.tsx`:
no navbar (or its 68px offset), no chat bubble, no mascot, no splash overlay, no
consent banner, no skip link, no site analytics. `NavigationBar` guards itself
too, because the shared lobby mounts it per page and `SiteChrome` cannot remove a
component a page renders.

The route accepts only the exportable keys — anything else is a 404 before
rendering — is `noindex`, and carries no outbound links or account prompts.

### 5.4 Suppress the lobby's online surfaces — **done**

`PvpLobby` now has a `practiceOnly` mode. `undefined` (the default) decides from
the route — practice-only on `/play/<gameKey>`, unchanged everywhere else — and
true/false overrides it. In practice mode the lobby renders no online Play
button, no stake picker, no open-lobby board, no quick queue, no "back to games"
link and no route to sign-in; the game's own practice action (`vsAi`, or a
game's `extraActions`) is the only way to start. The match panel switches to
Entry/Free, Opponent/The bot, Rated/No, Progress/this browser.

No game file changed: every exportable game already offers practice through the shared
lobby, and `tests/portal-surface.test.mjs` pins that each one keeps a practice
action, so the mode can never leave a portal visitor with nothing to press.

### 5.5 Checking it locally — **done**

`/portal-frame-harness.html` (from `public/`) frames `/play/dominoes?portal=poki`
in a real iframe, with `?game=`, `?portal=` and `?origin=` overrides. Open it from
the app's own origin — a same-origin parent is allowed by
`frame-ancestors 'self'` with no env var, so the surface, the practice-only
lobby and the post-match home button can all be checked without configuration.
It reports whether the frame loaded and is readable, and says so when no load
event arrives.

It does **not** test the external-origin policy: a cross-origin parent needs a
real https origin in `GRYND_PORTAL_FRAME_ORIGINS` plus a page served from it
(§5.1).

### 5.5 Store/social metadata and assets

A submission needs a cover, screenshots and a short description per game; the
repo has `docs/GRYND_ICON_SPEC.md` for the icon side but no per-game portal
asset set.

### 5.5b The board route — **done**

Four of the five games navigate to their board after "Play vs AI"
(`/casino/<game>/<id>`, and `/casino/odds/game/<id>`), and those paths keep
`frame-ancestors 'self'`. In a portal frame the navigation was refused and the
surface went blank at the first move.

`/play/<gameKey>/<matchId>` now renders the SAME match component the app serves
(the id segment has the same name, so `useParams()` works unchanged), and the
framing rule in `lib/portal/framing.ts` accepts the two-level shape. Navigation
is rewritten by `lib/portal/routes.ts` from inside `useMatchRouter`, which all
three match screens now use — so "back to lobby" and a rematch stay on the
framable path. Battleship has no board route because its match renders inside the
lobby page.

On that path a portal visitor gets no GRYND post-match ad and no GRYND account
invitation (`PvpResultScreen` suppresses both), and the CrazyGames bridge and the
home button are mounted there too, since the board is where a match actually
finishes.

### 5.6 The Poki home button — **done, and it is a deliberate exception**

A finished Poki match on `/play/<gameKey>?portal=poki` offers one button to
`https://grynd.dedyn.io`: `lib/portal/home.ts` (rules) +
`components/portal/PortalHomeButton.tsx` (the sheet). It waits for
`grynd:portal-match-finished`, opens in a new tab with
`rel="noopener noreferrer"`, passes only `utm_source`/`utm_medium`, never
navigates the portal's own page, and can be dismissed for that match.

**This conflicts with Poki's submission rules**, which forbid outbound links and
external account systems in a submitted build, and reviews for it. A reviewer may
reject the build over it. The button is therefore opt-in per portal
(`PORTAL_HOME_PORTALS` holds `"poki"` today): removing that slug removes the
button everywhere with no other change, so the decision stays reversible.

---

## 6. Verified vs assumed

**Verified in this repository (tests):** the export list matches the guest
practice list; every exported route exists; base-URL validation (https only, no
credentials/wildcards/query/fragment, subpath preserved); the launcher is
escaped, non-indexed, one iframe, no SDK script and no secret; the manifest
carries the portal's hosting shape, SDK requirement and framing entries; the CLI
writes exactly two files per pair and refuses invalid input.

**Assumed / not implemented:** portal approval, review outcomes, revenue terms,
required branding/loader assets, ad SDK contracts, leaderboard or account
integration, per-portal analytics approvals, and Poki's exclusivity decision.
Portal requirements were read from Poki's and CrazyGames' developer docs; they
change, so re-check before submitting.
