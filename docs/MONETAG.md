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
| Onclick (popunder) | **inside the 295730 answer itself**: its `onclick` block names sub-zone `12031481` (`zoneTypeId` 115) and carries the popunder options (`clickAnywhere`, `addOverlay`, `desktopPopunderEverywhere`, `clickTrackUrl` …) — no extra request, and the click handling is the tag's own `function onclick` code |
| Vignette Banner | `ekhay.com/vignette.min.js?z=12031483` — the vendor's own filename names this one |
| The web-push format | `auqot.com/pfe/current/tag.min.js?z=12031484` — the only loader carrying `Notification`, `applicationServerKey` and `subscribe`, **and** the only zone whose config returns `swName` |
| The remaining format | `b3mny.com/tag.min.js?z=12031482` — obfuscated differently, announces nothing about itself |

The whole `295730` answer is plain JSON with two top-level keys — `onclick` and
`extra_formats` — and it contains **no worker reference of any kind**: no
`swName`, no `sw.js`/`sw1.js`, no `serviceWorker`, no `register`, no `lary`, no
`importScripts`. The Onclick format therefore needs **no service worker at all**
— neither `/sw.js` nor `/sw1.js`. The worker requirement in this integration
belongs to sub-zone `12031484` (the web-push format, §2), which is exactly the zone
the downloaded file that was renamed to `sw1.js` binds to.

**Their dashboard's "Push Notifications" vs "In-Page Push" labels are not
established here.** The loaders only tell us which script serves which zone id;
`12031484` behaves like the web-push format (notification/permission machinery and
the worker requirement) and `12031482` announces nothing, so anything that has to
name them — support tickets especially — should name them **by zone id**, not by
format.

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
i.e. it asks the site for **`/sw.js` at the root**. Renaming the downloaded file
cannot change that: the name is server-side, per zone, and the answer is the same
whichever domain is asked. Measured for this property:

| Asked as | `swName` returned |
| --- | --- |
| `domain=www.grynd.dedyn.io` | `sw.js` |
| `domain=grynd.dedyn.io` | `sw.js` |
| `domain=localhost` | `sw.js` |

(`domain` in that same response is their rotating ad/worker CDN host — it moved
between three different values across those calls — and is not `swName`.) So
**nothing in Monetag's system looks for `sw1.js`**, which is why renaming the file
repeatedly changes nothing; only they can change the name, and until they do, the
file is served but unused.

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

## 6. Why the dashboard still says "installation error"

Monetag runs **three separate checks**, and they fail for different reasons. Do not
treat them as one:

| Check | What it looks for | State on this property |
| --- | --- | --- |
| 1. Site ownership | the verification method chosen when the site was added | **Done** — the file method is not used; the `<meta name="monetag" content="5ff7ccfa99ccd949f62b8eeaadc1d677">` tag is in the root layout and is present in the served HTML (`src/app/layout.tsx`, `metadata.other`). Nothing about the worker affects this check. |
| 2. The worker file | their own worker, at the path their zone names | **Not satisfiable as configured** — the path is `/sw.js` (see §2) and that path serves next-pwa's workbox worker (76 KB, `if(!self.define){…`), not theirs. This is the check a "generic installation error" on a site that already has a service worker is most consistent with. |
| 3. The zone installation | the zone's own tag, once, in the page | **Satisfied** — one `<script id="monetag-multitag" async data-cfasync="false" data-zone="295730" src="https://quge5.com/88/tag.min.js">` element, verified in the rendered HTML locally and on the deployed domain. |

There is **no separate installation step for the Onclick format** — verified against
the zone's own JSON (§1), not inferred: the Onclick block for sub-zone `12031481`
carries popunder options and **no worker keys whatsoever**. So an "Onclick
installation error" cannot be a missing Onclick worker: there is nothing of the kind
to install. The worker file that was renamed to `sw1.js` belongs to the **In-Page
sub-zone (`12031484`) — which is also the only zone whose configuration names
a worker file at all. If what their dashboard is really reporting is the site-level
worker check, that is the one requirement this deployment cannot meet as configured
(row 2 above).

One further possibility worth ruling out **in the dashboard, not by guessing**: the tag
is deliberately served on the browsing pages only (§3) and is absent from every match
route. If Monetag's own checker samples a match URL, it will not find the tag there
and can report an installation problem for a reason that has nothing to do with the
worker. Their dashboard shows which URL was checked; that is the place to look, and
it is also the fastest question to put to their support alongside the `swName`
request.

**The safest supported fix** is therefore support, not more renaming: ask Monetag to
set this zone's `swName` to `sw1.js`, which is already served at the root with the
right content type, `Cache-Control: no-store` and `Service-Worker-Allowed: /`. Quote
the table in §2 as evidence. The alternatives are worse and deliberate:

* **Merging their bootstrap into next-pwa's worker** would make `/sw.js` contain
  their code, but their import installs a `fetch` handler (measured, §2), i.e. it
  would share a worker with workbox's routing — and the imported host in the
  downloaded file (`3nbf4.com`) is not stable. That is the change that can break
  offline caching, so it is not made silently.
* **Uploading their file as `/sw.js`** replaces the PWA's worker outright. Explicitly
  not done.

## 7. Verified on the deployed site

Measured against the production domain (`https://www.grynd.dedyn.io`), not just a
local build:

| What | Deployed result |
| --- | --- |
| `/` HTML | exactly **one** tag element: `<script id="monetag-multitag" async data-cfasync="false" data-zone="295730" src="https://quge5.com/88/tag.min.js">` |
| Site verification meta | `<meta name="monetag" content="5ff7ccfa99ccd949f62b8eeaadc1d677"/>` present |
| `/sw1.js` | **200**, `application/javascript; charset=utf-8`, 156 bytes, `Cache-Control: no-store`, `Service-Worker-Allowed: /`, HSTS, `X-Matched-Path: /sw1.js` |
| `/sw1.js` body | the network's bootstrap (`self.options` + `self.lary` + `importScripts`) |
| `/sw.js` | **200**, 76,083 bytes of next-pwa workbox — **not** Monetag's worker |
| Redirects | `http://grynd.dedyn.io/sw1.js` → **308** → `https://grynd.dedyn.io/sw1.js` → **308** → `https://www.grynd.dedyn.io/sw1.js`, i.e. the file is served at the root of the canonical host |

A local production build (`npm run build && npx next start`) produces the same tag,
the same meta tag and the same two worker responses, differing only in next-pwa's
own byte count (76,086 vs 76,083). So **nothing about this integration is failing
for a hosting or packaging reason** — the file is in the build, at the root, with the
right headers on the real domain.

One operational note: `/sw1.js` comes back through the CDN with `X-Vercel-Cache: HIT`
and an `Age` header even though it carries `Cache-Control: no-store`. If that file's
contents ever change, expect the edge to serve the previous copy until it is
revalidated.

## 8. Dashboard steps (Monetag side)

1. The site is verified — the `monetag` meta tag in the root layout is the
   verification method in use. No file upload is required for that.
2. Confirm the zone is the MultiTag (`295730`): the dashboard marks MultiTag
   zones with a `MULTI` sign and they carry the four formats under one name.
3. To make the network's worker usable, ask support to set the zone's `swName` to
   `sw1.js` — the name already served here, at the root, with the right content type
   and scope (see §7). Their API answers `sw.js` for this domain today (§2), which is
   the one path this site cannot hand over. Do not upload a file named `sw.js`: that
   path is the PWA's, and overwriting it breaks offline caching.
4. Nothing to configure for Onclick — it is part of the same tag. Do not paste a
   second copy of the tag.
