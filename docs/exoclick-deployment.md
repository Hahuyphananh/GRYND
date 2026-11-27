# ExoClick banner — deployment and operating notes

The ExoClick banner is **disabled by default** and has **no built-in zone**.
Deploying this code changes nothing a visitor sees until an operator supplies a
real zone id and the provider-generated `<ins>` class token.

The integration lives in:

| Concern | File |
| --- | --- |
| Configuration, validation, placement/route rules | `src/lib/exoclick/config.ts` |
| Server gates (native app, switches, placement, membership) | `src/components/ads/ExoClickBanner.tsx` |
| Browser loader, consent gate, one-per-document injection, no-fill handling | `src/components/ads/ExoClickBannerUnit.tsx` |
| CSP hosts | `src/lib/security/csp.ts`, `src/proxy.ts` |
| Contract tests | `tests/exoclick-banner.test.mjs` |

## 1. What the dashboard has to provide

Create a **Banner** zone (desktop or mobile banner — not sticky, push,
interstitial, direct link, popunder or video slider), then copy the
**Asynchronous Script** tag from *Your Zone HTML Tag*. It has this shape:

```html
<script async type="application/javascript"
  src="a.magsrv.com/ad-provider.js"></script>

<ins class="<ZONE_CLASS>" data-zoneid="<ZONE_ID>"></ins>

<script>(AdProvider = window.AdProvider || []).push({"serve": {}});</script>
```

Two values are account-specific and must be copied exactly:

- `<ZONE_ID>` → `NEXT_PUBLIC_EXOCLICK_ZONE_<PLACEMENT>` (numeric)
- `<ZONE_CLASS>` → `NEXT_PUBLIC_EXOCLICK_INS_CLASS` (or the per-placement
  override)

**Never** put an ExoClick password, API key or dashboard credential in this
repository, and never in a `NEXT_PUBLIC_*` variable. Zone ids and class tokens
are public (they appear in the page source); account credentials are not.

## 2. Configuration

| Variable | Scope | Rebuild? |
| --- | --- | --- |
| `NEXT_PUBLIC_EXOCLICK_ENABLED` | build-time switch | yes |
| `EXOCLICK_ENABLED` | server, read per request | no — restart only |
| `NEXT_PUBLIC_EXOCLICK_ZONE_HOME` | build-time | yes |
| `NEXT_PUBLIC_EXOCLICK_ZONE_LEADERBOARD` | build-time | yes |
| `NEXT_PUBLIC_EXOCLICK_ZONE_PROFILE` | build-time | yes |
| `NEXT_PUBLIC_EXOCLICK_ZONE_HUB` | build-time (reserved; no page mounts the hub) | yes |
| `NEXT_PUBLIC_EXOCLICK_INS_CLASS` | build-time, required | yes |
| `NEXT_PUBLIC_EXOCLICK_INS_CLASS_<PLACEMENT>` | optional override | yes |
| `NEXT_PUBLIC_EXOCLICK_BANNER_SIZE` | `300x250` (default), `728x90`, `responsive` | yes |
| `NEXT_PUBLIC_EXOCLICK_BANNER_SIZE_<PLACEMENT>` | optional override | yes |
| `NEXT_PUBLIC_EXOCLICK_SCRIPT_URL` | optional loader override; https on `*.magsrv.com` / `*.exoclick.com` | yes |
| `NEXT_PUBLIC_EXOCLICK_REQUIRES_CONSENT` | defaults to `true` | yes |

Both switches must be opted in (`true` / `1`). Anything else, including an
absent line, leaves the banner off.

## 3. Enabling it

```bash
# 1. build with the switches and the zone values
NEXT_PUBLIC_EXOCLICK_ENABLED=true \
NEXT_PUBLIC_EXOCLICK_ZONE_HOME=<id> \
NEXT_PUBLIC_EXOCLICK_ZONE_LEADERBOARD=<id> \
NEXT_PUBLIC_EXOCLICK_ZONE_PROFILE=<id> \
NEXT_PUBLIC_EXOCLICK_INS_CLASS=<class> \
npm run build

# 2. add the runtime switch to the app's env file, then restart the app
EXOCLICK_ENABLED=true
```

## 4. Where it can appear

Only the browsing pages the existing architecture already monetises:

- `/` — `home`
- `/classement` — `leaderboard`
- `/profil` — `profile`
- `/games`, `/casino` — `hub` (declared, but no page mounts it today)

Never a lobby below its own URL, a match, a Solitaire board, a live queue, a
gameplay control area or the post-match video overlay. The client unit
re-checks the **exact pathname** and the shared gameplay classifier before it
creates any element.

## 5. Consent

With `NEXT_PUBLIC_EXOCLICK_REQUIRES_CONSENT` on (the default), the provider tag
is not injected until `grynd_cookie_consent` is `accepted`. In the EEA/UK/CH
Google's certified CMP writes that record through `CmpConsentBridge` (TCF
purpose 1), so the same gate applies there. Undecided and declined both fail
closed. Accepting while on the page loads the banner without a reload.

## 6. Native app

`ExoClickBanner` asks `isNativeShellDocument()` first. The Android/iOS WebView
receives no container, no `<ins>` and no loader — no request leaves the app.

## 7. No-fill and failure

- The provider draws into our `<ins>`; fill is detected by a real creative
  element or a laid-out box, not by “the script loaded”.
- An empty zone collapses the reserved area after 8 seconds
  (`EXOCLICK_READY_TIMEOUT_MS`), leaving no blank box.
- A blocked loader (`script-src`) or refused creative frame (`frame-src`)
  collapses immediately through the CSP violation listener.
- No placeholder creative, no retry loop and no error card.

## 8. Verification

```bash
npm run test:exoclick
npx tsc --noEmit
```

Then, on a deployed build with the provider enabled and consent accepted:

```bash
curl -s https://<host>/ | grep -c 'grynd-exoclick-banner'
# 1 on the home page; 0 on /casino/solitaire-duel/play-ai and any match URL
```

Check the browser console for CSP violations from `magsrv.com`. If a creative
frame is refused, the missing host must be added to `frame-src` in
`src/proxy.ts` — not replaced with `https:`.

## 9. Known limitation

ExoClick's asynchronous tag does not expose a fill/impression callback. The
banner therefore reports “filled” only when a creative node or a laid-out box
appears. Do not treat script load as an impression, and do not use this signal
to cascade to another network in the same slot.
