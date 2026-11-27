# Three-provider ad fallback

GRYND serves banners and post-match video through **one opportunity at a time**.
HilltopAds, ExoClick and Adcash are ranked by configuration; the chain asks the
highest-priority **enabled and eligible** provider first and falls through only
when that provider explicitly fails to fill. The first creative wins and ends
the chain.

No new provider format, zone, tag or publisher value is invented here. Each
provider still uses only its own `*_ENABLED`, `*_ZONE` / `*_TAG` and consent
settings.

## Priority (deploy-time, no code change)

```dotenv
NEXT_PUBLIC_ADS_BANNER_ORDER=hilltop,exoclick,adcash
NEXT_PUBLIC_ADS_VIDEO_ORDER=hilltop,exoclick,adcash
```

- Unknown names are ignored; duplicates collapse; an empty/invalid list falls
  back to `hilltop,exoclick,adcash`.
- Listing a provider does **not** enable it. Its own switches and zone/tag are
  still required, and banners still require an approved placement.
- Both variables are public and inlined by Next at build time, so changing the
  order is a deploy, not a runtime edit.

Bounded waits:

| Variable | Default | Clamp |
|---|---|---|
| `NEXT_PUBLIC_ADS_BANNER_PROVIDER_TIMEOUT_MS` | 3500 | 1500–8000 |
| `NEXT_PUBLIC_ADS_BANNER_BUDGET_MS` | 8000 | 2000–15000 |
| `NEXT_PUBLIC_ADS_VIDEO_BUDGET_MS` | 6000 | 2000–12000 |

A provider may never use more than the remaining chain budget, even when its
own deadline is longer. When the budget is spent, no further provider is tried.

## Outcomes

Every attempt resolves to one of:

- `filled` — a creative is available; the chain stops.
- `no_fill` — the provider answered and had nothing to serve.
- `timeout` — no creative before the attempt deadline.
- `blocked` — consent/CSP/abort/policy refused the request.
- `network_error` — the tag or creative could not be fetched.
- `invalid_response` — unreadable XML, a refused Wrapper/VPAID, or no playable
  media.
- `provider_disabled` — switched off or unconfigured (normally filtered out
  before the chain starts).

A script `load` is **never** treated as a fill or an impression.

### Fill detection per provider

| Provider | Signal | Limitation |
|---|---|---|
| HilltopAds | A non-`<script>` child appears in our container | The snippet exposes no fill callback; an empty container at the deadline is `timeout` |
| ExoClick | The provider fills our `<ins>` with a creative node or a laid-out box | No documented no-fill callback; empty at deadline is `timeout` |
| Adcash | `aclib.runBanner` draws into our container | No documented no-fill callback; empty at deadline is `timeout` |

For video, the VAST HTTP response is the signal: `no-ad`/`empty` is `no_fill`,
transport failures are `network_error`, malformed/refused documents are
`invalid_response`, and the request deadline is `timeout`. Wrappers are still
refused and VPAID is never executed (see `docs/vast-providers.md`).

## One slot, one creative

- Every page that carries a banner mounts exactly one `BannerSlot`. The individual
  `HilltopBanner`, `ExoClickBanner` and `AdcashBanner` components are no longer
  page-mounted; mounting one beside the chain would create two containers.
- The client runs providers sequentially in one container
  (`src/lib/ads/banners/runtime.ts`). It clears that container between attempts.
  No `Promise.all`, no provider overlap.
- A `filled` result returns before any later provider is attempted. There is no
  post-fill fallback path.

## Deduplication and frequency

- **Banner opportunity**: stable per document + placement. `claimOpportunity`
  allows React's development double-effect to re-enter under the same owner,
  but refuses a second mounted instance and refuses a served opportunity. A
  real remount in the same document therefore does not request again.
- **Video opportunity**: `video:<matchId>` plus a sessionStorage marker. The
  existing cadence already records each completed match once; the marker is a
  second guard against replaying the same result after a refresh.
- **Impressions**: the player's `impressionSentRef`/`startSentRef`/
  `completeSentRef` remain the only emitters. Fallback never runs after a
  creative is ready.
- **Frequency**: no ads during gameplay; banners only on `/`, `/games`
  (`/casino`), `/classement` and `/profil`; the post-match cadence and dismissal
  record are unchanged; a dismissed match is not re-offered.

## Entitlement, native and consent

- `BannerSlot` is a server component. A native-shell document gets no markup,
  no script and no request. A GRYND PRO member (`isAdFreeViewer`) gets nothing
  either.
- The browser re-checks the exact route, the shared match classifier and the
  consent record.
- Providers requiring consent (ExoClick and Adcash by default) are filtered out
  while consent is undecided/declined, so they are not requested and not
  reported as errors. Accepting later re-runs the chain. Hilltop keeps its
  existing no-consent-flag behavior.
- Gameplay routes are rejected by placement and by `isMatchHref`; no gameplay
  page mounts `BannerSlot`.

## Metrics

`src/lib/ads/core/report.ts` emits provider-level PostHog events:

`ad_request`, `ad_fill`, `ad_no_fill`, `ad_timeout`, `ad_blocked`, `ad_error`,
`ad_impression`, `ad_video_start`, `ad_video_complete`.

Properties are limited to surface kind, provider, placement, short status/
reason, latency and `verified_impression`. No user id, match id, opportunity id,
tag/zone or URL is sent. **No revenue event is emitted**: these providers do not
expose an authoritative revenue source to this app, and impressions are never
inferred from a script load.

- Banners report `ad_fill` with `verified_impression: false`: display networks
  give us no verified impression callback.
- Video reports `ad_impression`, start and completion only from the media
  element's own `play`/`ended` events.

## Tests

`npm run test:fallback` covers fill at each provider, both two-provider fallback
paths, all-provider no-fill, timeout, disabled provider, budget exhaustion,
abort, duplicate/claimed/served opportunities, refresh dedupe, ad-free/native/
gameplay gates, order configuration, outcome mapping, single-container
sequencing and the reporting payload.

Existing provider suites remain authoritative for configuration and CSP:
`test:ads`, `test:exoclick`, `test:adcash`, `test:vast`, `test:vast-providers`,
`test:native-ads`.
