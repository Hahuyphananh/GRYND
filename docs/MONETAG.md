# Monetag — what is installed, what it can and cannot do

This is the reference for the second ad provider. It records **measured** facts
(zone endpoints, a real browser run against a production build, and the network's
own worker executed in a sandbox), so nobody has to re-derive them — and so that
a claim like "sw1.js is our worker" never gets written down again without the
evidence behind it.

The ad *model* — entitlement server-side, no ad code inside gameplay — lives in
`src/lib/ads.ts`, `src/components/MonetagScript.tsx`, `src/components/AdSlot.tsx`
and is pinned by `tests/ad-model.test.mjs`. This file is about the network
integration itself.

## 1. One tag installs all four formats (including Onclick)

Monetag's zone `295730` is a **MultiTag**. Its own documentation: *"MultiTag
consists of 4 ad formats: Onclick, Push Notifications, In-Page Push, Vignette
Banner … All you need to do is grab a new ad code, insert one ad tag into your
website's source code."*

That is what is installed — the provider's tag, verbatim, once per browsing page:

```html
<script id="monetag-multitag" src="https://quge5.com/88/tag.min.js"
  data-zone="295730" async data-cfasync="false"></script>
```

**There is no separate "Onclick script" or "Onclick zone" to add.** Measured
chain for this zone:

| What | Where it comes from |
| --- | --- |
| The MultiTag loader (`data-zone="295730"`) | `quge5.com/88/tag.min.js`, ours |
| Its zone answer | `6opo.com/88/295730?dmn=quge5.com` |
| Onclick (popunder) | the tag's own `function onclick` code — no extra request |
| Push Notifications | `b3mny.com/tag.min.js?z=12031482` |
| Vignette Banner | `ekhay.com/vignette.min.js?z=12031483` |
| In-Page Push | `auqot.com/pfe/current/tag.min.js?z=12031484` |

Adding the tag a second time would inject **the same zone twice** (two
popunders), not a second format. `tests/ad-model.test.mjs` pins one loader per
page.

## 2. The service worker (`sw.js` / `sw1.js`)

The dashboard's `sw.js` download is the network's worker file. Its **name is
decided by Monetag's server**, not by us: the zone endpoint answers with

```json
{ "code": "jsTagParameters", "swName": "sw.js", "zoneId": 12031484, "domain": "kmnts.com", … }
```

and their loader calls `navigator.serviceWorker.register(...)` with that name —
i.e. it asks the site for **`/sw.js` at the root**.

`/sw.js` on this site belongs to **next-pwa** (`next.config.js`, `dest: "public"`),
which regenerates it on every build. Both cannot own that path. The current
arrangement, and what was measured:

- `public/sw1.js` holds the network's worker under the name it was renamed to by
  hand, served from the root path with `Cache-Control: no-store` and
  `Service-Worker-Allowed: /` (next.config.js).
- **Nothing requests it today.** In a real browser against a production build —
  notifications permitted, clicks and pointer movement simulated — the tag made
  zero service-worker registrations and zero requests for `/sw1.js`, while all
  four of its format scripts loaded normally.
- We never register it ourselves. A second worker at the ROOT scope displaces
  next-pwa's, which is the one regression this integration can cause;
  `qa/monetag-browser-check.mjs` reports which workers claim the root scope.
- Folding the network's bootstrap **into** next-pwa's worker is possible
  (next-pwa's custom-worker support), but it is a deliberate change, not a
  tidy-up: executed in a sandbox, their worker installs a **`fetch`** handler
  alongside `push`, `notificationclick`, `notificationclose`,
  `pushsubscriptionchange`, `install`, `activate` and `message`. A `fetch`
  handler in the same worker as workbox's routing is exactly how offline caching
  regresses.
- A copy of the worker at the **repo root** is never served at all (only
  `public/` is) — it was deleted, and a test asserts it does not come back.

**To have the worker actually used** (web-push subscription and everything the
network gates behind it), ask Monetag support to set this zone's `swName` to
`sw1.js`. Only they can change it, and the file and headers for it are already in
place. The site itself is verified by the **meta tag** method
(`other.monetag` in `src/app/layout.tsx`), so verification does not depend on the
worker file.

## 3. Can a format be triggered on demand? (post-match, video, rewarded)

**No — not on a regular website, with these formats.**

- Onclick, Push Notifications, In-Page Push and Vignette Banner are all
  *automatic* once the tag is on the page: the network decides when they appear
  (a click, an interval, a scroll nudge, an opt-in push prompt). There is no
  website-side "show it now" call for any of them.
- The on-demand API — `show_<zoneId>({ type: 'preload' | 'inApp' | 'pop' })` —
  is the **Telegram Mini App SDK**. Monetag's own documentation for the format a
  video ad would need (Rewarded Interstitial: *"implement the format in your
  Telegram Mini App"*, *"Always test your integration inside Telegram, not just
  in a browser"*) is Mini-App-only. Using it on a normal website is not
  supported.
- Nothing here fakes one: no iframe, no other network, and no in-game reward,
  rating or competitive benefit is ever given for watching anything.

**So a post-match video ad is not implemented, because no supported website
format exists to implement it with.** What the current arrangement *does* deliver
is the enforceable half of the requirement: the tag is loaded only on browsing
pages (`/`, `/games`, `/classement`, `/profil`, and each game lobby whose board
lives on its own match route), so no popunder, vignette or in-page push can
interrupt a live match, and there is no match-route code path that could start
one.

**One measured limitation, for free viewers only.** The gate stops ad code being
*emitted* on a no-ad route, which is the enforceable half. It cannot un-load a tag
that is already running in the document: measured in a real browser, a free
viewer who soft-navigates (App Router client navigation) from an ad page to a
page that carries no loader still has the tag **and all three format scripts it
injected** live in that document, so a vignette or in-page-push unit can still
appear after such a hop. A hard navigation clears it. No supported call stops
those units, so this is inherent to third-party page-level scripts rather than
something to paper over — and it does not affect GRYND PRO, whose responses never
contain the tag in the first place.

If a post-match placement is ever wanted, the supported shape is a **manually
placed display unit** — the AdSense slot in `src/components/AdSlot.tsx`, which
*is* placed by us and *does* render where we put it (e.g. on the shared
`src/components/result/PvpResultScreen.jsx` after the match ends, never on a
rematch button or a timer). That is a product decision about a second provider's
surface, not a Monetag configuration, and it would need its own review of the
"ads never reach gameplay" rule.

## 4. GRYND PRO

Ad-free is unchanged and provider-neutral: `src/lib/adEntitlement.ts`
(`isAdFreeViewer`, memoized per request, Clerk + the caller's own subscription
row) gates **all three** ad surfaces — `MonetagScript`, `AdSenseScript` and
`AdSlot` — and there is no fourth: `AdUnit` is the only browser-side ad code and
exists only inside `AdSlot`'s markup, so it cannot render for a member by
construction. A member's response contains no Monetag tag and no AdSense tag,
i.e. no ad code and no ad request at all.

The tiers are exactly two (`MembershipTier = "free" | "pro"`), and every
*active* subscription — `active`, `trialing`, `past_due`, including the
deprecated Grynd+ / High Roller plans — resolves to `pro`, so no paid account
can fall through the `=== "pro"` comparison. `findActiveSubscription` reads the
caller's own row from the database on every request (no cross-request cache);
`cache()` only dedupes the lookup within one render.

`tests/ad-slot-gate.test.mjs` drives the REAL `AdSlot`, `AdSenseScript` and
`MonetagScript` with the membership answer mocked, and asserts a member
receives `null` from all three (and a free viewer receives each provider's own
tag). Removing the `isAdFreeViewer()` check from `MonetagScript` makes that test
fail with *"a member must receive no Monetag tag"*, so the assertion is not
vacuous.

One bounded exception, deliberate and documented in `lib/adEntitlement.ts`: the
check **fails open** if Clerk or the database is unreachable — we cannot prove
membership, so the viewer is treated as free and may see an ad for the duration
of the incident. The alternative (treating everyone as a member) would hand the
paid entitlement to the whole internet during an outage.

## 5. Verifying it

```bash
npm run build && npx next start -p 3112   # production build
npm run verify:monetag                    # real browser: ad requests, workers, console
npm run test:ads                          # the ad-model contract
```

`verify:monetag` prints the ad-network requests the tag makes, requests for
`/sw.js`/`/sw1.js` on our own origin, the service-worker registrations and their
scopes, and any console errors.

## 6. Dashboard steps (Monetag side)

1. The site is verified — the `monetag` meta tag in the root layout is the
   verification method in use. No file upload is required for that.
2. Confirm the zone is the MultiTag (`295730`): the dashboard marks MultiTag
   zones with a `MULTI` sign and they carry the four formats under one name.
3. To make the network's worker usable, ask support to set the zone's `swName` to
   `sw1.js` (the name already served here). Do not upload a file named `sw.js`:
   that path is the PWA's, and overwriting it breaks offline caching.
4. Nothing to configure for Onclick — it is part of the same tag. Do not paste a
   second copy of the tag.
