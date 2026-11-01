// src/lib/hilltop/config.ts
//
// THE ONE PLACE THE HILLTOPADS BANNER IS CONFIGURED.
//
// ── WHAT THIS ADDS (AND DOES NOT TOUCH) ───────────────────────────────────
//
// A third, INDEPENDENT ad provider. Nothing here imports AdSense
// (src/lib/ads.ts, AdSlot, AdUnit, AdSenseScript) or the post-match VAST
// pipeline (src/lib/vast/*), and neither of those imports this. Switching the
// banner off cannot affect them, and switching them off cannot affect it.
//
// ── THE SUPPLIED PROVIDER CODE, PRESERVED ─────────────────────────────────
//
// The provider's loader is an INLINE snippet that creates a `<script>`, copies
// its own settings object onto it, sets the provider URL, `async` and the
// referrer policy, and inserts the tag BEFORE itself:
//
//   s.settings = uxjuqz || {};
//   s.src = "//juvenilechoice.com/bqXMV…/MKwp";
//   s.async = true;
//   s.referrerPolicy = 'no-referrer-when-downgrade';
//   l.parentNode.insertBefore(s, l);
//   })({})
//
// `hilltopBannerSnippet()` reproduces that text exactly (same URL, same `{}`
// settings argument, same async flag, same referrer policy, same
// insert-before-itself order), with the URL injected as a single value. The
// provider's own `\/` escapes are redundant escapes of `/`, so the string VALUE
// is identical — see tests/hilltop-banner.test.mjs, which pins the URL, the
// settings object, the flags and the insertion order.
//
// ── WHERE THE BANNER LANDS ────────────────────────────────────────────────
//
// The provider does NOT accept a container from this snippet: `appendTo` is not
// set by `({})`. Its own fallback chain is (1) a selector target if `appendTo`
// were set, (2) the parent of its own script tag, (3) an absolutely positioned,
// max-z-index element on `<body>`. Option 3 is an OVERLAY, and it is what a
// `<head>`-hoisted loader would get.
//
// So the snippet is executed from inside OUR container element (the component
// appends it there, which is also what makes an inline script execute at all).
// The provider's tag is then a child of that container, so its own rule (2)
// inserts the banner next to it — inside the container, never over the page.
// That containment is structural; it does not rely on undocumented settings.
//
// ── CONFIGURATION (exact names) ───────────────────────────────────────────
//
//   HILLTOP_BANNER_ENABLED                 server, read per request. Must be
//                                          "true"/"1" to enable the banner;
//                                          anything else (including unset)
//                                          keeps it off with no rebuild.
//   NEXT_PUBLIC_HILLTOP_BANNER_ENABLED     build-time switch. Same opt-in rule.
//   HILLTOP_BANNER_PROVIDER_ATTESTED       server. The written provider
//                                          confirmation described below. Same
//                                          opt-in rule.
//   NEXT_PUBLIC_HILLTOP_BANNER_SCRIPT_URL  optional override. Must be https (or
//                                          protocol-relative) on the approved
//                                          provider host, with no credentials.
//                                          An INVALID override renders nothing
//                                          rather than silently falling back.
//
// ── WHY THE DEFAULT IS OFF ────────────────────────────────────────────────
//
// Because two of the provider's behaviours are NOT ours to control, and this
// repo only ships third-party code it can actually restrain:
//
//   1. The creative renders in a cross-origin iframe created with NO `sandbox`,
//      NO `allow-top-navigation` and NO `allowfullscreen` attribute (verified in
//      the fetched loader: zero occurrences of all three). Whatever that
//      creative does — open a tab on click, request fullscreen on a gesture — is
//      outside our reach.
//   2. The loader has `fullscreen` and `blur` modes COMPILED IN
//      (`settings.fullscreen`, `settings.blur`) that are decided by the provider
//      per zone at runtime. Our `({})` settings object cannot turn them off
//      (`copyUserSettings` only accepts `scriptSrc`, `ads` and `appendTo`).
//
// The loader's OWN code is clean (0 `window.open`, 0 `location.assign`/`replace`,
// 0 `target=_blank`, 0 Notification/push APIs), but that is only half of the ad.
// So the banner stays OFF until an operator records the provider's written
// confirmation and sets HILLTOP_BANNER_PROVIDER_ATTESTED=true. Enabling is one
// deliberate step; shipping intrusive creatives by default is not.
//
// ── FREQUENCY ─────────────────────────────────────────────────────────────
//
// The provider exposes NO frequency control: its `copyUserSettings` reads
// exactly `scriptSrc`, `ads` and `appendTo`, and the build contains no
// impression cap, daily cap or cooldown of any kind. Nothing here invents one.
// The single lever this integration owns is honest and structural: the tag is
// loaded AT MOST ONCE per browser session, so a second page in the same tab
// shows nothing because nothing is injected — not because a running ad has been
// hidden.

/** The provider URL exactly as supplied (protocol-relative, as the snippet). */
export const HILLTOP_PROVIDER_SCRIPT_URL =
  "//juvenilechoice.com/bqXMV.sXdGGwlp0oYEWCcI/HeAmt9/uXZuUklDkMPBTQcD1DOAD/Qb2ZNYDuk/tXNQzzUv4rNRDTY-1/MKwp";

/** The only host an override may point at. */
export const HILLTOP_PROVIDER_HOST = "juvenilechoice.com";

/** The provider's referrer policy, preserved verbatim. */
export const HILLTOP_REFERRER_POLICY = "no-referrer-when-downgrade";

/** The settings object the snippet passes: `({})`, exactly as supplied. */
export const HILLTOP_BANNER_SETTINGS: Readonly<Record<string, never>> = Object.freeze({});

/** The container the snippet is executed inside (and the ad is contained by). */
export const HILLTOP_CONTAINER_ID = "grynd-hilltop-banner";

/** Marks an injected snippet element, so a remount can never inject twice. */
export const HILLTOP_SNIPPET_ATTRIBUTE = "data-grynd-hilltop-snippet";

/** One load per browser session (tab), across reloads and navigations. */
export const HILLTOP_SESSION_KEY = "grynd:hilltopBanner:v1";

/** Reserved area while the creative loads, so an arriving ad cannot shift the page. */
export const HILLTOP_RESERVED_HEIGHT_PX = 250;

/** How long a blocked or unfilled request may hold the reserved area. */
export const HILLTOP_READY_TIMEOUT_MS = 8_000;

/**
 * The ONLY surfaces a banner may appear on: the browsing pages that already
 * carry AdSense. Never a match/board route, never a gameplay route below a
 * lobby, never a lobby-and-board-in-one game. The component refuses any other
 * value, and tests/hilltop-banner.test.mjs walks the route tree to prove no
 * gameplay page mounts it.
 */
export const HILLTOP_PLACEMENTS = ["home", "hub", "leaderboard", "profile"] as const;

export type HilltopPlacement = (typeof HILLTOP_PLACEMENTS)[number];

export function isHilltopPlacement(value: unknown): value is HilltopPlacement {
  return (
    typeof value === "string" &&
    (HILLTOP_PLACEMENTS as readonly string[]).includes(value)
  );
}

/**
 * The ONE route each placement belongs to.
 *
 * This is what turns "four approved pages" from a code-review promise into a
 * browser-enforced rule: the unit refuses to inject unless the pathname being
 * viewed is listed for the placement it was given. A game lobby, a match, a
 * board or an alias is simply absent from every list, so mounting the banner
 * anywhere else injects nothing.
 *
 * `/casino` and `/games` are both accepted for the hub because Next rewrites
 * `/games` onto the `/casino` route (the browser address bar keeps `/games`, but
 * a direct `/casino` render must not silently lose its own banner).
 */
export const HILLTOP_PLACEMENT_ROUTES: Readonly<
  Record<HilltopPlacement, readonly string[]>
> = Object.freeze({
  home: ["/"],
  hub: ["/games", "/casino"],
  leaderboard: ["/classement"],
  profile: ["/profil"],
});

/**
 * True when `pathname` is exactly the route this placement is allowed to serve.
 * Exact matching on purpose — a prefix rule would quietly admit `/profil/<id>`,
 * `/games/<slug>/play` (a lobby) and `/casino/<game>/<board>`.
 */
export function hilltopRouteMatchesPlacement(
  pathname: string | null | undefined,
  placement: unknown,
): boolean {
  if (!isHilltopPlacement(placement)) return false;
  if (typeof pathname !== "string") return false;

  const path = pathname.split(/[?#]/)[0];
  // Trailing slashes are the only tolerated difference (/profil/ ≡ /profil).
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return HILLTOP_PLACEMENT_ROUTES[placement].includes(normalized);
}

/** Opt-in switch: only an explicit "true" / "1" turns anything ON. */
function switchOn(value: string | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/** Build-time switch (`NEXT_PUBLIC_HILLTOP_BANNER_ENABLED`). Off unless opted in. */
export function hilltopBannerEnabled(): boolean {
  return switchOn(process.env.NEXT_PUBLIC_HILLTOP_BANNER_ENABLED);
}

/** Runtime switch (`HILLTOP_BANNER_ENABLED`), read per request on the server. */
export function hilltopBannerEnabledOnServer(): boolean {
  return switchOn(process.env.HILLTOP_BANNER_ENABLED);
}

/**
 * PROVIDER ATTESTATION (`HILLTOP_BANNER_PROVIDER_ATTESTED`).
 *
 * Set only after HilltopAds confirms IN WRITING that this zone cannot enable
 * the `fullscreen`/`blur` modes, cannot force a popunder or top-window
 * navigation from a creative, and that creatives are served in an iframe we can
 * keep out of gameplay. It is our own compliance gate — not a provider option —
 * and it exists so the unverifiable half of the ad cannot be switched on by
 * accident. Without it the banner renders nothing at all.
 */
export function hilltopProviderAttested(): boolean {
  return switchOn(process.env.HILLTOP_BANNER_PROVIDER_ATTESTED);
}

/**
 * Validate a provider URL. Protocol-relative (`//host/path`) is what HilltopAds
 * supplied and is accepted; `https://host/path` is the equivalent absolute form.
 * Everything else — another host, `http:`, credentials, an unparsable or absurd
 * value — resolves to null so the banner renders NOTHING instead of loading a
 * tag we cannot vouch for.
 */
export function normalizeHilltopScriptUrl(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw || raw.length > 2_048) return null;

  const absolute = raw.startsWith("//") ? `https:${raw}` : raw;

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== HILLTOP_PROVIDER_HOST) return null;
  if (parsed.username || parsed.password) return null;

  // Returned unmodified (no rewrite) — the provider's value is what loads.
  return raw;
}

/**
 * The URL this deploy will load.
 *
 * No override → the supplied provider URL. An override is validated and, if it
 * is malformed, resolves to null (fail closed) rather than silently reverting to
 * a different tag.
 */
export function hilltopBannerScriptUrl(): string | null {
  const override = (process.env.NEXT_PUBLIC_HILLTOP_BANNER_SCRIPT_URL ?? "").trim();
  if (!override) return HILLTOP_PROVIDER_SCRIPT_URL;
  return normalizeHilltopScriptUrl(override);
}

/**
 * THE PROVIDER'S SNIPPET, reproduced exactly.
 *
 * `String.raw` keeps every backslash of the original text; the only substituted
 * value is the URL, which `hilltopBannerScriptUrl()` has already validated. The
 * settings argument stays `({})`, `async` stays true, the referrer policy is
 * unchanged, and the tag is still inserted BEFORE the snippet that creates it.
 */
export function hilltopBannerSnippet(scriptUrl: string): string {
  return String.raw`(function(uxjuqz){
var d = document,
    s = d.createElement('script'),
    l = d.currentScript || d.scripts[d.scripts.length - 1];
s.settings = uxjuqz || {};
s.src = "${scriptUrl}";
s.async = true;
s.referrerPolicy = 'no-referrer-when-downgrade';
l.parentNode.insertBefore(s, l);
})({})`;
}

/**
 * The cheap, server-side gates: switched on, provider configuration valid, and
 * a placement this integration is allowed to serve. Deliberately excludes the
 * entitlement answer so a page that can never show the banner never performs a
 * membership lookup.
 */
export function hilltopBannerAllowed({
  enabled,
  configured,
  placement,
}: {
  enabled: boolean;
  configured: boolean;
  placement: unknown;
}): boolean {
  return enabled && configured && isHilltopPlacement(placement);
}

/**
 * The final gate. `adFree` is the SERVER's answer (`isAdFreeViewer()` — Clerk
 * session + the caller's own subscription row), never a client flag, so a GRYND
 * PRO member gets no markup, no script and no request.
 */
export function hilltopBannerVisibleToViewer({
  allowed,
  adFree,
}: {
  allowed: boolean;
  adFree: boolean;
}): boolean {
  return allowed && !adFree;
}

/** sessionStorage, or null when the browser denies it (the ad still works). */
export function hilltopBannerSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** True when this tab already loaded the provider's tag. Fails closed (false). */
export function hilltopBannerLoadedThisSession(
  storage: Pick<Storage, "getItem"> | null,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(HILLTOP_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

/** Records the load. Never throws: a denied store only loses cross-page dedupe. */
export function markHilltopBannerLoaded(storage: Pick<Storage, "setItem"> | null): void {
  if (!storage) return;
  try {
    storage.setItem(HILLTOP_SESSION_KEY, "1");
  } catch {
    // Memory guard in the component still prevents a second injection.
  }
}
