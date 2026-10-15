# Monetag Support Request — Onclick Installation Error

**Website:** https://www.grynd.dedyn.io/
**Onclick container zone:** `295730`
**Status:** Installation error remains unresolved; Monetag dashboard verification is unavailable to us.

Hello Monetag Support,

I'm experiencing an installation error for my Onclick zone (container zone ID `295730`) on https://www.grynd.dedyn.io/.

## 1. Verified installation

The following Onclick tag is served exactly once as a script element on each intended browsing page:

```html
<script id="monetag-multitag" async="" data-cfasync="false"
        data-zone="295730" src="https://quge5.com/88/tag.min.js"></script>
```

The production tag-coverage matrix was checked live. Each listed URL returned HTTP 200.

- **Main browsing pages:** `/`, `/games`, `/classement`, `/profil`
- **Dedicated game-lobby routes:** `/games/tower-arena/play`, `/games/mines-pvp/play`, `/games/barricade/play`, `/games/memory-grid/play`, `/games/chess/play`

The tag is deliberately absent from active gameplay routes, including `/games/chess/ai`, and from games where the lobby itself is the board, including `/games/odds/play` and `/games/dice-flush/play`. This is intentional: our product rule is that pop-under, vignette, and in-page-push ads must not fire during a live match.

Consequently, if your verification checker samples one of these intentionally excluded URLs, it will not find the tag there. Please confirm which exact URL your checker fetches.

Note: the string `quge5.com/88/tag.min.js` may occur twice in the raw HTML byte stream because it appears once in the script element and once in Next.js's serialized React Server Components payload. There is exactly one script element.

## 2. Site ownership and production checks

The following have been verified:

- The site-verification meta tag is present in the rendered production HTML.
- `/sw1.js` returns HTTP 200, with a JavaScript content type and root scope permissions.
- `/sw.js` is an existing Next-PWA/Workbox service worker and must not be overwritten.
- The production build succeeds.

## 3. Zone configuration findings

Parsing the response for container zone `295730` yields two top-level keys: `onclick` and `extra_formats`.

The Onclick configuration contains internal zone ID `12031481`, with no references to a service worker, worker filename, service-worker registration, or worker import.

The zone IDs involved, as observed in the zone responses and the scripts they load:

- `295730` — the container (the `data-zone` of the tag above)
- `12031481` — Onclick (from the `onclick` block of the `295730` response, `zoneTypeId` 115)
- `12031483` — served by `ekhay.com/vignette.min.js?z=12031483` (Vignette Banner)
- `12031484` — served by `auqot.com/pfe/current/tag.min.js?z=12031484`
- `12031482` — served by `b3mny.com/tag.min.js?z=12031482`

We deliberately do **not** assert which of `12031482` / `12031484` your dashboard labels "Push Notifications" versus "In-Page Push" — the delivered files do not announce that, so we refer to them by zone ID. What we can state is that **`12031484` is the only one whose server-side configuration specifies a worker**: its zone response returns `swName: "sw.js"`, and its loader is the one carrying `Notification` / `applicationServerKey` / `subscribe`.

For `www.grynd.dedyn.io`, that configuration answers `swName: "sw.js"`:

```
GET https://auqot.com/zone?pub=0&zone_id=12031484&is_mobile=false&domain=www.grynd.dedyn.io
    &var=&ymid=&var_3=&tg=0&sw=3.1.647&drf=
→ {"code":"jsTagParameters","swName":"sw.js","zoneId":12031484, ...}
```

(The same `swName` comes back for the apex domain and for `localhost`.)

Our site already uses `/sw.js` for its Next-PWA/Workbox worker, and replacing it would break our offline behaviour. The Monetag worker was therefore kept separately at `/sw1.js` rather than overwriting the existing PWA worker.

## 4. Requested support actions

Please:

1. Identify which verification check is failing: site ownership, service-worker installation, or Onclick tag detection.
2. Confirm the exact URL your checker fetches.
3. Confirm whether Onclick zone `12031481` requires a service worker at all.
4. If internal zone `12031484` (the one whose configuration returns `swName: "sw.js"`) is responsible for the worker conflict, can you change its server-side `swName` to `sw1.js` for `www.grynd.dedyn.io`? The file is already served at the root with the correct type and root scope.
5. If Monetag's worker must instead live at `/sw.js`, what is the supported arrangement for an origin that must keep its own worker there — a documented second filename, a marker or meta declaration, or an allowlist? Is merging your bootstrap into our existing worker supported? We are reluctant to merge it because the worker script registers a `fetch` handler, which would sit alongside Workbox's routing in the same worker and risk our offline caching.
6. Confirm whether any further action is required to activate Onclick zone `295730`.

We have not claimed that Monetag verification succeeded. We are requesting confirmation of the server-side configuration and the exact failing check.

Thank you.
