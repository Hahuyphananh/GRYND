# Advertising deployment guide — HilltopAds, ExoClick, Adcash

Status: **release candidate, not production-approved**. This guide describes the
code that exists, the values an operator must supply, and the checks that must be
run on staging before a GO. It does not claim live provider verification.

## 1. What is implemented

| Surface | Provider | State in code | Default |
| --- | --- | --- | --- |
| Browsing banner (`BannerSlot`) | HilltopAds | implemented, exact-host CSP, consent-gated | **off** |
| Browsing banner | ExoClick | implemented, exact-host CSP, consent-gated | **off** |
| Browsing banner | Adcash | implemented, exact-host CSP, consent-gated | **off** |
| Post-match video | HilltopAds | implemented, approved VAST tag built in, consent-gated | on* |
| Post-match video | ExoClick | implemented, no tag built in, consent-gated | **off** |
| Post-match video | Adcash | implemented, no tag built in, consent-gated | **off** |

\* The post-match surface is on unless `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false`
or the server route returns `enabled: false`. Hilltop is the only video provider
with an approved tag in the repository.

All three providers share one sequential fallback chain per opportunity. A
provider is requested only if its own switch is on, its required account values
exist, its placement is allowed and consent is `accepted`.

## 2. Consent and privacy

The shared record is the `grynd_cookie_consent` cookie, read through
`src/lib/cookieConsent.ts` and updated by the existing consent UI / Google CMP
bridge (`CmpConsentBridge` mirrors TCF purpose 1 into that record).

- Every banner provider requires consent by default:
  `NEXT_PUBLIC_HILLTOP_BANNER_REQUIRES_CONSENT`,
  `NEXT_PUBLIC_EXOCLICK_REQUIRES_CONSENT`,
  `NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT`.
- Post-match video requires consent by default:
  `NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT=true`.
- While consent is undecided or declined, no provider script, iframe, VAST tag
  or tracking request is made. The banner draws no reserved box; the post-match
  player reports “no offer” so the result screen is never held.
- Only an explicit `false` exempts a provider. Do not set it for an EEA/UK/CH
  deployment governed by the CMP; the default is the compliant path.
- The ad metrics payload contains provider, placement, status, reason, latency
  and whether an impression was verified. It contains no user identifier,
  revenue, tag URL or query string.

Preserve the existing Google AdSense/CMP behaviour: the CMP script and
`fundingchoicesmessages.google.com` remain allowed, and the consent bridge is
unchanged.

## 3. Obtain provider values

### HilltopAds banner

1. In the HilltopAds publisher panel, create/select a **standard banner** zone.
2. Copy the provider tag supplied for that zone. The shipped tag already points
   at `juvenilechoice.com`; a replacement must stay on that exact host.
3. Obtain **written confirmation** that the zone cannot enable fullscreen/blur,
   cannot force a popunder or top-window navigation, and serves creatives in an
   iframe that can stay out of gameplay.
4. Set `HILLTOP_BANNER_PROVIDER_ATTESTED=true` only after that confirmation.

### HilltopAds VAST

The approved post-match tag is built in
(`HILLTOPS_VAST_TAG` in `src/lib/vast/config.ts`). To rotate it, set
`NEXT_PUBLIC_HILLTOPS_VAST_URL` to the new https tag; a malformed value fails
closed.

### ExoClick banner

1. Create a **Banner** zone. Do not use sticky, popunder, interstitial, direct
   link, push or video-slider formats.
2. Copy the numeric zone id and the `<ins class="…">` token from the
   asynchronous tag.
3. Set the per-placement zone and class values, then the switches.

### ExoClick VAST

Create a **video** zone and copy its VAST tag. The adapter accepts Inline linear
responses only; Wrapper and VPAID are refused. Set
`NEXT_PUBLIC_EXOCLICK_VAST_TAG` and `NEXT_PUBLIC_EXOCLICK_VAST_ENABLED=true`.

### Adcash display

1. Create a **Display** zone (not pop-under, autotag, interstitial, in-page push
   or video slider).
2. Copy the numeric zone id and the library script URL from the panel.
3. Set `NEXT_PUBLIC_ADCASH_LIBRARY_URL` and the zone variables.

The library URL is the same for every zone:
`https://acscdn.com/script/aclib.js` (the panel prints it protocol-relative as
`//acscdn.com/script/aclib.js`; both forms are accepted and normalised to
https).

**An Autotag zone cannot be used, and is refused.** Adcash documents Autotag as
a 4-in-1 tag that rotates **Pop-Under, Interstitial, In-Page Push and Video
Slider** (`aclib.runAutoTag({ zoneId })`). Three of those are formats this
product prohibits, so the integration never calls `runAutoTag`, and a `zt…`
zone id pasted into `NEXT_PUBLIC_ADCASH_ZONE_*` resolves to nothing
(`isAdcashAutotagZoneId` in `src/lib/adcash/config.ts`). Create a Display zone
for banners and an in-stream video zone for the post-match VAST tag instead.

### Adcash VAST

Create an in-stream video zone, copy its VAST tag, and set
`NEXT_PUBLIC_ADCASH_VAST_TAG` plus `NEXT_PUBLIC_ADCASH_VAST_ENABLED=true`.

## 4. Environment variables

### Build-time (`NEXT_PUBLIC_*`) — rebuild required

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_ADS_BANNER_ORDER` | Banner priority, e.g. `hilltop,exoclick,adcash` |
| `NEXT_PUBLIC_ADS_VIDEO_ORDER` | Video priority |
| `NEXT_PUBLIC_ADS_ROTATION` | Rotate the first eligible provider per opportunity. Defaults to **on**; `false` keeps the configured strict priority |
| `NEXT_PUBLIC_ADS_BANNER_PROVIDER_TIMEOUT_MS` | Per-banner attempt deadline |
| `NEXT_PUBLIC_ADS_BANNER_BUDGET_MS` | Whole banner-chain budget |
| `NEXT_PUBLIC_ADS_VIDEO_BUDGET_MS` | Whole video-chain budget |
| `NEXT_PUBLIC_HILLTOP_BANNER_ENABLED` | Hilltop banner build switch |
| `NEXT_PUBLIC_HILLTOP_BANNER_REQUIRES_CONSENT` | Defaults to true |
| `NEXT_PUBLIC_HILLTOP_BANNER_SCRIPT_URL` | Optional exact-host override |
| `NEXT_PUBLIC_HILLTOPS_ENABLED` | Hilltop video provider switch |
| `NEXT_PUBLIC_HILLTOPS_VAST_URL` | Hilltop video tag override |
| `NEXT_PUBLIC_EXOCLICK_ENABLED` | ExoClick banner build switch |
| `NEXT_PUBLIC_EXOCLICK_ZONE_*` | Zone id per placement |
| `NEXT_PUBLIC_EXOCLICK_INS_CLASS*` | Zone class token |
| `NEXT_PUBLIC_EXOCLICK_REQUIRES_CONSENT` | Defaults to true |
| `NEXT_PUBLIC_EXOCLICK_VAST_ENABLED` | ExoClick video switch |
| `NEXT_PUBLIC_EXOCLICK_VAST_TAG` | ExoClick video tag |
| `NEXT_PUBLIC_ADCASH_ENABLED` | Adcash banner build switch |
| `NEXT_PUBLIC_ADCASH_LIBRARY_URL` | Adcash library URL |
| `NEXT_PUBLIC_ADCASH_ZONE_*` | Display zone id per placement |
| `NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT` | Defaults to true |
| `NEXT_PUBLIC_ADCASH_VAST_ENABLED` | Adcash video switch |
| `NEXT_PUBLIC_ADCASH_VAST_TAG` | Adcash video tag |
| `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED` | Master video kill switch (`false` off) |
| `NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT` | Defaults to true |

### Runtime (server) — restart, no rebuild

| Variable | Purpose |
| --- | --- |
| `HILLTOP_BANNER_ENABLED` | Hilltop banner server switch |
| `HILLTOP_BANNER_PROVIDER_ATTESTED` | Written provider attestation |
| `EXOCLICK_ENABLED` | ExoClick banner server switch |
| `ADCASH_ENABLED` | Adcash banner server switch |
| `POST_MATCH_ADS_ENABLED` | Server video kill switch for `/api/ads/post-match` |
| `ADS_CREATIVE_HOSTS` | Exact provider creative/tracking origins for CSP |
| `ADS_MEDIA_HOSTS` | Exact VAST media CDN origins for CSP |

### Rotation between providers

With a strict priority list the first configured provider wins every slot it
can fill, and the second one is only ever a fallback. HilltopAds additionally
loads **at most once per tab**, so on a second page of the same tab it reports
`no_fill` and every later banner would depend on the next provider.

`NEXT_PUBLIC_ADS_ROTATION` (default **on**) rotates the *eligible* order by a
hash of the opportunity id:

- a different document, placement or match id picks a different first provider,
  so HilltopAds and Adcash roughly alternate instead of one always leading;
- the same opportunity id always produces the same order, so a React remount or
  a re-render cannot reorder a chain that is already running;
- rotation only re-orders — switches, configuration, placement and consent still
  decide *which* providers are in the list;
- no provider is ever requested twice for one opportunity: the chain still stops
  at the first `filled`.

Set `NEXT_PUBLIC_ADS_ROTATION=false` to restore the strict configured priority.
The banner slot (`BannerSlotClient`) and the post-match player
(`PostMatchVideoAd`, through `videoProviderChain(opportunityId)`) both use it.

`ADS_CREATIVE_HOSTS` / `ADS_MEDIA_HOSTS` are comma-separated **bare https
origins** (`https://cdn.provider.example`). Paths, credentials, `http:` and
wildcards are rejected. The CSP is built per request, so these take effect after
a process restart; `NEXT_PUBLIC_*` changes require a rebuild.

## 5. CSP and account-specific hosts

The policy is in `src/lib/security/csp.ts`; `src/proxy.ts` emits it.

- `script-src`, `connect-src` and `frame-src`: exact provider hosts —
  `juvenilechoice.com`, `a.magsrv.com`, `acscdn.com`, `adcash.com`. There is no
  provider wildcard.
- Adcash **display delivery** is on `rapidadexchange.com` (the zone's creative
  JSON and its impression pixel) with a heartbeat to `usrpubtrck.com`, and the
  creative image itself on `crcdn.org`. All three are exact `connect-src` /
  `img-src` sources; a browser run on 2026-11-27 showed `aclib.js` is only a
  loader that pulls `acscdn.com/script/banner.js` and then that zone endpoint.
- `img-src`: named app/ad hosts only. The old bare `https:` is gone.
- `media-src`: `'self'`, `blob:`, the origin of each configured VAST tag,
  `ADS_MEDIA_HOSTS`, and the exact creative hosts observed in real tag
  responses — `www.dismal-library.pro` for Hilltop and `vidwestxyz.com` for the
  Ad Exchange MP4s (2026-11-27). The old bare `https:` is gone.
- `connect-src` includes each configured VAST tag origin, because the browser
  fetches the XML directly. The approved Hilltop tag origin is
  `rude-movie.com`; its impression/error beacons are also served there and are
  allowed by `img-src`.

A provider's creative iframe/tracking CDN and a VAST MediaFile's redirect CDN are
account-specific. If the browser console shows a `securitypolicyviolation`, read
the blocked URI, confirm it is the provider's documented host, and add that exact
origin to `ADS_CREATIVE_HOSTS` or `ADS_MEDIA_HOSTS`. Do **not** add `https:`, a
provider wildcard or an unrelated host to make an ad paint.

**Known release gate:** without staging tags, the real ExoClick/Adcash creative
and media hosts are unknown. Until they are captured from the browser and added,
those creatives may be blocked (which fails closed). This is a reason for NO-GO
on those providers, not a reason to widen the policy. Hilltop's approved tag was
read on 2026-11-27 and its exact tag/beacon (`rude-movie.com`) and media
(`www.dismal-library.pro`) hosts are in the default policy; a future creative on
a different CDN must be added through `ADS_MEDIA_HOSTS`.

## 6. Enable, disable and roll back

Disable one banner provider (no rebuild):
`HILLTOP_BANNER_ENABLED=false`, `EXOCLICK_ENABLED=false` or
`ADCASH_ENABLED=false`. The other providers remain eligible.

Disable one video provider (no rebuild for the server route; the build-time
provider switch needs a rebuild):
`NEXT_PUBLIC_HILLTOPS_ENABLED=false`, `NEXT_PUBLIC_EXOCLICK_VAST_ENABLED=false`
or `NEXT_PUBLIC_ADCASH_VAST_ENABLED=false`.

Disable all ads:
`POST_MATCH_ADS_ENABLED=false`, `HILLTOP_BANNER_ENABLED=false`,
`EXOCLICK_ENABLED=false`, `ADCASH_ENABLED=false`, and rebuild with
`NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false`,
`NEXT_PUBLIC_HILLTOP_BANNER_ENABLED=false`,
`NEXT_PUBLIC_EXOCLICK_ENABLED=false`,
`NEXT_PUBLIC_ADCASH_ENABLED=false`. This also removes the AdSense surface only if
its own existing switch is used; this guide does not change AdSense.

Rollback:
1. Flip the runtime/server switches above first (fastest, no deploy).
2. If the build is implicated, redeploy the previous known-good commit and its
   environment.
3. Restore the previous `public/ads.txt` only if you changed it. Never remove the
   AdSense record while AdSense is serving.
4. Re-check the CSP header and that `/ads.txt` is served verbatim.

## 7. Test fallback and fill

Use staging with account-generated tags; never use production tags for a
destructive test.

1. **Consent-off:** clear `grynd_cookie_consent`, load a banner page and a
   finished match. In DevTools → Network, filter by each provider host. There
   must be **zero** provider requests. Accept consent, then reload; requests may
   start.
2. **Priority:** set `NEXT_PUBLIC_ADS_BANNER_ORDER` and inspect the order of
   `ad_request` events/requests. The second provider must not be requested until
   the first resolves.
3. **No-fill:** block the first provider's host in DevTools request blocking.
   The chain must move to the next provider; the result screen must remain
   usable and the post-match overlay must not appear if all providers fail.
4. **CSP:** block/observe a creative host. A `securitypolicyviolation` should
   collapse the banner (no permanent blank reserved box) and the video should
   fail closed.
5. **PRO/native:** use a PRO session — no banner markup, no video request. Load
   in the native shell — no third-party ad request.
6. **Gameplay:** load a live Solitaire board and a match; no banner slot and no
   video overlay before `matchEnded`.

Metrics: PostHog ad events record `ad_request`, per-provider outcomes
(`ad_no_fill`, `ad_timeout`, etc.) and a verified video impression only when the
media element actually played. A banner creative is a fill, not a verified
impression.

## 8. ads.txt

`public/ads.txt` currently contains the AdSense record only. No ExoClick, Adcash
or HilltopAds seller record has been added because none of the required
account-specific values (ad-system domain, seller/publisher id, relationship,
certification-authority id) are present in the repository, and public provider
documentation checked for this release did not establish a mandatory record.

Before enabling a provider:
1. Open its publisher dashboard / authorization page.
2. If it supplies an ads.txt record, copy it **verbatim**.
3. Deploy and confirm `https://<domain>/ads.txt` serves the new line.
4. Never invent a seller id, `DIRECT`/`RESELLER` relationship or CA id.

## 9. Release checks

```bash
npx tsc --noEmit
npm run test:ad-compliance
npm run test:fallback
npm run test:vast
npm run test:ads
npm run test:exoclick
npm run test:adcash
npm run test:native-ads
npm run test:proxy
node --import tsx --test tests/hilltop-banner.test.mjs
npm run build
```

A green suite proves the code's contracts, not that a provider served an ad.
Physical-browser and provider-live verification require staging credentials and
account-generated tags and must be reported separately.

## 8. Ad earnings (admin Operations page)

`/admin/operations` shows a **Ad earnings** panel fed by
`GET /api/admin/ad-earnings?days=7|30`. The route is admin-only twice over:
`proxy.ts` gates `/api/admin/*`, and the handler re-checks `isAdmin`.

The figures come from each network's publisher reporting API, server-side:

| Network | Credential | Notes |
| --- | --- | --- |
| HilltopAds | `HILLTOP_REPORTING_API_KEY` | `publisher/listStats`; also needs `HILLTOP_REPORTING_CURRENCY` because the API returns no currency |
| ExoClick | `EXOCLICK_REPORTING_API_TOKEN` | `POST /v2/login` → `/v2/statistics/p/global`; also needs `EXOCLICK_REPORTING_CURRENCY` (statistics are rate limited to 30/min per IP) |
| Adcash | `ADCASH_REPORTING_API_TOKEN` | `POST /auth/token` → `/publishers/reports`; currency comes from the response (`meta.currency`). Optional `ADCASH_REPORTING_BASE_URL` for an account-specific subdomain |

Rules the implementation enforces:

- **No invented numbers.** A network that is unconfigured, fails, or answers in
  a shape the adapter cannot read is shown as such and contributes **nothing**
  to a total. It is never rendered as `0.00`.
- **No invented exchange rates.** Totals are grouped per currency; a single
  total appears only when every reporting network uses the same currency.
- **Server-only credentials.** Tokens are read from server env, used in a
  request header, and never returned or logged. Only totals and short
  diagnostics reach the browser.
- **Cached for five minutes** in process, so opening the page does not burn the
  providers' rate limits. Statistics also lag behind real traffic; today's
  figure can still move.
- **HilltopAds response schema is unpublished.** Its adapter reads
  revenue/impressions/clicks field names defensively and reports
  `unreadable response` when it cannot find them. If that appears, check the
  current HilltopAds docs and adjust `fetchHilltopEarnings`.

The panel does not depend on the ad switches: it reports historical earnings
even while a network is disabled for serving.

## 9. Ad Exchange post-match video (youradexchange.com)

The account's video tag for grynd.dedyn.io is:

```
https://youradexchange.com/video/select.php?r=12500162
```

It is wired as a fourth, **video-only** provider (`adexchange`) in the shared
post-match chain. It is not a banner: there is no display zone behind it, and
`bannerProviderEligible` refuses it, so it can never appear on a browsing page
or over a board.

The surface's existing gates apply unchanged:

- **After a finished match only** — `PostMatchVideoAd` mounts only when
  `matchEnded` is true, on the result screen. Finished puzzle results count:
  the end of a daily run, a graded unlimited position, a completed strategic
  puzzle, and a settled Puzzle Ranked / AI session. Each is keyed by its run
  (UTC date, puzzle key, session id), so resuming or reloading the same result
  cannot offer twice.
- **No ads for GRYND PRO** — the hosting page resolves `ad_free` server-side
  and renders nothing, so a member triggers no request.
- **Consent first** — the same `NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT`
  gate (default true) and the same cadence/one-per-match rule.
- **Inline only** — the strict parser refuses Wrapper and VPAID. This tag
  returned Inline ads on 2026-11-27 (H.264 MP4s on `vidwestxyz.com`); when it
  answers an empty `<VAST/>` that is a real no-fill: the next provider is tried
  and, if none fills, no overlay is drawn.

Configuration (the tag is built in, but the provider is **OFF by default**):

On 2026-11-27 this tag served hardcore adult video creatives (and a gambling
creative on another draw) in a real browser. It stays disabled — and its tag
stays in code — until the network filters that category. Do not opt in until
that is confirmed in writing; see §10.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_ADEXCHANGE_VAST_ENABLED` | `false` removes this provider |
| `NEXT_PUBLIC_ADEXCHANGE_VAST_TAG` | Override the tag (https only) |
| `NEXT_PUBLIC_ADEXCHANGE_VAST_TIMEOUT_MS` | Per-attempt deadline, 1000–8000 |

CSP: `https://youradexchange.com` is named exactly in `connect-src`,
`media-src` and `img-src`. The tag host is known; the CDN that will serve the
actual MP4 was not observable while the tag answers empty. If a real creative
is blocked by `media-src`, read the blocked origin from the browser console and
add it to `ADS_MEDIA_HOSTS` — do not widen the policy.

### Adcash live configuration (2026-11-27)

The account's real values are built in, so the Display banner is configured
without another deploy step:

- library: `https://acscdn.com/script/aclib.js`
- Display zones: `12500178` (300x250) and `12500186` (728x90), both numeric —
  never Autotag ids. They are used as a pool, rotating per placement; a
  per-placement `NEXT_PUBLIC_ADCASH_ZONE_<PLACEMENT>` override wins.
- The reserved container follows the zone it landed on, so the 728x90 creative
  is not clipped into a 300px box (`ADCASH_ZONE_SIZES` in
  `src/lib/adcash/config.ts`).
- **the switches are opt-in and OFF by default**: only `true`/`1`/`on`/`yes`
  enables them, for both `NEXT_PUBLIC_ADCASH_ENABLED` and `ADCASH_ENABLED`.
  They were briefly defaults-on, then a real browser run on 2026-11-27 showed
  the live zone serving an explicit adult creative on the homepage. The
  integration stays, but it must not serve until Adcash applies a non-adult
  creative/category filter to the account (see §10).

An explicit invalid override (wrong host, non-numeric zone, `zt…` Autotag id)
still fails closed — it is never silently replaced with the built-in value.

The banner remains gated on the exact browsing route (`/`, `/games|/casino`,
`/classement`, `/profil`), never the native app, never GRYND PRO, and only
after consent says `accepted`.

## 10. Content-safety stop (2026-11-27)

A real Chrome run against production filled both third-party surfaces. The
creatives were explicit adult advertisements:

- Adcash Display zone `12500178` (300x250 inside the `BannerSlot` on `/`): a
  hardcore dating banner with a click-through to `rapidadexchange.com`.
- Ad Exchange (`youradexchange.com/video/select.php?r=12500162`) on the
  post-match result screen: a hardcore adult video, and a slot-machine gambling
  creative on another draw.

Both networks are Adcash-family exchanges and neither exposes a category filter
in the tag request this integration makes, so nothing client-side can keep the
inventory clean. The impact is not cosmetic: adult creatives beside AdSense risk
the AdSense account, and they are disallowed by the mobile store listings.

Actions taken in code:

- `NEXT_PUBLIC_ADCASH_ENABLED` / `ADCASH_ENABLED` are opt-in again (unset = off).
- `NEXT_PUBLIC_ADEXCHANGE_VAST_ENABLED` is opt-in (unset = off).
- The library, zones, tag and CSP origins stay in place, so re-enabling is a
  variable change once the account is filtered.

Before any re-enable, get written confirmation from the network that the website
and zone serve **non-adult** creatives only, then spot-check a live result and
banner in a browser before leaving it on. Keep `HILLTOP_BANNER_PROVIDER_ATTESTED`
off until the same check covers Hilltop creatives.

The stop is effective only once a release is activated: the publish job skips
a commit that is no longer the tip of the source branch, so land the change in
the final commit and confirm the live page makes no provider request.

Reversing the stop is an environment change, not a code change: opt in with
`NEXT_PUBLIC_ADCASH_ENABLED` + `ADCASH_ENABLED` (banner) or
`NEXT_PUBLIC_ADEXCHANGE_VAST_ENABLED` (video), then activate a release. The CSP
already names every origin those creatives need.

### Re-enable checklist

1. Get **written** confirmation from Adcash that the website and every zone
   (`12500178`, `12500186`, and video tag `r=12500162`) serve non-adult
   creatives only. A generic policy page is not confirmation for this account.
2. Set the repository variables `NEXT_PUBLIC_ADCASH_ENABLED=true` and/or
   `NEXT_PUBLIC_ADEXCHANGE_VAST_ENABLED=true` (the release workflow passes both
   through). Nothing else in the build needs to change.
3. On the host, add `ADCASH_ENABLED=true` to `/home/ubuntu/grynd/env/app.env`
   (mode 0600) for the banner; the video needs only the build variable.
4. Activate a release, then restart so the env file is re-read.
5. Load `/` and finish one practice game in a real browser several times. If an
   adult creative appears once, turn the variable off and redeploy immediately —
   the networks randomise creatives per request, so a single clean load proves
   nothing.

## Ad performance by game mode (PostHog)

Every post-match ad event carries `ad_mode` (`solo`, `daily`, `puzzle-daily`,
`puzzle-unlimited`, `puzzle-ranked`, `puzzle-ai`, `puzzle-strategic`,
`duel-ranked`, `duel-practice`) and `placement = "post-match"`. The dimension is a
short bounded token — match ids, URLs, zone ids and free text are dropped by
`buildAdEvent` in `src/lib/ads/core/report.ts`. The duel mode comes from the
casino result screen (`isPractice ? "duel-practice" : "duel-ranked"`); the free
practice and puzzle surfaces derive theirs from the match id.

Read-only report (needs `POSTHOG_PERSONAL_API_KEY` with `query:read` and
`POSTHOG_PROJECT_ID`; never pass a key on the command line):

```bash
node --env-file=/home/ubuntu/grynd/env/app.env scripts/ads/posthog-mode-report.mjs --days=30
npm run ads:posthog -- --days=7 --json
```

It prints requests, fills, fill rate, no-fills, blocked, errors, impressions,
starts, completes and play rate per mode. `untagged` is an event without
`ad_mode` (older builds, or a surface that does not pass one).

Saved insight (PostHog UI, because creating one via API needs an `insight:write`
key): **Insights → New insight → Trends**, event `ad_fill` and `ad_impression`,
filter `placement = post-match`, breakdown by event property `ad_mode`. For a
fill-rate trend, add `ad_request` to the series and switch to formula mode with
`B / A * 100` (fills ÷ requests). `ad_mode` only exists from the build that
shipped it, so earlier periods stay `untagged`/empty.
