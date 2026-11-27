# Adcash display banner — deployment and operating notes

The Adcash banner is **disabled by default** and has **no built-in zone or
library URL**. Deploying this code changes nothing a visitor sees until an
operator supplies both values from the Adcash publisher panel.

The integration lives in:

| Concern | File |
| --- | --- |
| Configuration, validation, placement/route rules | `src/lib/adcash/config.ts` |
| Server gates (native app, switches, placement, membership) | `src/components/ads/AdcashBanner.tsx` |
| Library loading, `runBanner` execution, consent, no-fill handling | `src/components/ads/AdcashBannerUnit.tsx` |
| CSP hosts | `src/lib/security/csp.ts`, `src/proxy.ts` |
| Contract tests | `tests/adcash-banner.test.mjs` |

## 1. What the dashboard has to provide

Create a **Display** zone (Adcash: skyscraper, rectangle or leaderboard — not
Pop-Under, Autotag, Interstitial, In-Page Push or Video Slider) and copy the
two snippets Adcash issues:

1. **Adcash library** — the `aclib` script URL.
2. **Display zone script** — the `aclib.runBanner(...)` call and its zone id.

The integration reproduces only the documented display call:

```html
<script src="<ADCASH_LIBRARY_URL>"></script>
<script>
  aclib.runBanner({
    zoneId: "<ZONE_ID>",
    renderIn: "#<GRYND_CONTAINER_ID>"
  });
</script>
```

`renderIn` is a `querySelector`; GRYND supplies the container so the creative
renders inside it. The zone id and library URL are **not defaulted** and must
not be guessed.

Never put an Adcash password, API key or dashboard credential in this
repository or in a `NEXT_PUBLIC_*` variable. Zone ids and the library URL are
public (they appear in the page source).

## 2. Configuration

| Variable | Scope | Rebuild? |
| --- | --- | --- |
| `NEXT_PUBLIC_ADCASH_ENABLED` | build-time switch | yes |
| `ADCASH_ENABLED` | server, read per request | no — restart only |
| `NEXT_PUBLIC_ADCASH_LIBRARY_URL` | build-time, **required** | yes |
| `NEXT_PUBLIC_ADCASH_ZONE_HOME` | build-time, **required for home** | yes |
| `NEXT_PUBLIC_ADCASH_ZONE_LEADERBOARD` | build-time | yes |
| `NEXT_PUBLIC_ADCASH_ZONE_PROFILE` | build-time | yes |
| `NEXT_PUBLIC_ADCASH_ZONE_HUB` | build-time (reserved; no page mounts the hub) | yes |
| `NEXT_PUBLIC_ADCASH_BANNER_SIZE` | `300x250` (default) or `728x90` | yes |
| `NEXT_PUBLIC_ADCASH_BANNER_SIZE_<PLACEMENT>` | optional override | yes |
| `NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT` | defaults to `true` | yes |

Both switches must be opted in (`true` / `1`). Anything else, including an
absent line, leaves the banner off.

## 3. Enabling it

```bash
# 1. build with the switches and the dashboard values
NEXT_PUBLIC_ADCASH_ENABLED=true \
NEXT_PUBLIC_ADCASH_LIBRARY_URL=<library url> \
NEXT_PUBLIC_ADCASH_ZONE_HOME=<zone id> \
NEXT_PUBLIC_ADCASH_ZONE_LEADERBOARD=<zone id> \
NEXT_PUBLIC_ADCASH_ZONE_PROFILE=<zone id> \
npm run build

# 2. add the runtime switch to the app's env file, then restart the app
ADCASH_ENABLED=true
```

## 4. Where it can appear

- `/` — `home`
- `/classement` — `leaderboard`
- `/profil` — `profile`
- `/games`, `/casino` — `hub` (declared, but no page mounts it today)

Never a lobby below its own URL, a match, a Solitaire board, a live queue, a
gameplay control area or the post-match video overlay. The client unit
re-checks the exact pathname and the shared gameplay classifier before loading
anything.

## 5. Consent and app exclusion

- With `NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT` on (default), the library is not
  loaded until `grynd_cookie_consent` is `accepted`. In the EEA/UK/CH Google's
  certified CMP writes that record through `CmpConsentBridge` (TCF purpose 1).
  Undecided and declined fail closed. Accepting while on the page draws the
  banner without a reload.
- `AdcashBanner` asks `isNativeShellDocument()` first: the Android/iOS WebView
  receives no container and no Adcash library.

## 6. Duplicate and failure handling

- The library is appended at most once per document (DOM sentinel).
- `runBanner` is executed at most once per zone per document (module-scoped
  set). A React remount reuses the element and observes the container rather
  than calling the provider again.
- Fill is detected from a creative node or a laid-out box inside our container,
  never from “the library loaded”.
- An unfilled zone collapses after 8 seconds (`ADCASH_READY_TIMEOUT_MS`).
- A blocked library (`script-src`) or refused creative frame (`frame-src`)
  collapses immediately through the CSP violation listener.
- No placeholder creative, no retry loop, no error card.

## 7. Verification

```bash
npm run test:adcash
npx tsc --noEmit
```

On a deployed build with the provider enabled and consent accepted:

```bash
curl -s https://<host>/ | grep -c 'grynd-adcash-banner'
# 1 on the home page; 0 on /casino/solitaire-duel/play-ai and any match URL
```

Then watch the console for CSP violations from `acscdn.com` / `adcash.com`. Add
the exact missing host to `script-src`, `connect-src` and `frame-src` — never
replace the allow-lists with `https:`.

## 8. Known limitation

Adcash's Display API does not expose a fill callback. The banner reports
“filled” only when a creative node or laid-out box appears inside the GRYND
container. Do not treat library load as an impression, and do not use this
signal to cascade to another network in the same slot.
