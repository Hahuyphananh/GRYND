// src/lib/attribution.ts
//
// FIRST-TOUCH ACQUISITION ATTRIBUTION.
//
// The funnel tracker used to read UTM parameters off the CURRENT URL on every
// page. Two consequences: a visitor who arrived on `/?utm_source=tiktok` and
// then navigated to `/sign-up` lost the channel before signup, and a later
// tagged visit (e.g. a retargeting link) overwrote the original person
// properties. Neither is acceptable for acquisition reporting.
//
// This module keeps ONE bounded first-touch record per browser:
//
//   * `parseAttribution(url)` reads only the five UTM fields plus `ref`.
//   * `classifyChannel()` normalises the source/referrer to the channel
//     vocabulary the reporting needs (tiktok, instagram, youtube, reddit,
//     product_hunt, x, search, direct, referral).
//   * `mergeFirstTouch()` NEVER overwrites a value already captured; it only
//     fills gaps. First touch therefore stays first touch.
//
// No cookies, no fingerprinting, no personal data: channel strings, campaign
// strings and the landing path only. Storage access is wrapped so a blocked
// localStorage (private mode, embedded webviews) degrades to the current URL
// instead of throwing.

export const ATTRIBUTION_STORAGE_KEY = "grynd:attribution:first-touch";

/** Only these query parameters are read. Anything else is ignored. */
export const ATTRIBUTION_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
] as const;

export type AcquisitionChannel =
  | "tiktok"
  | "instagram"
  | "youtube"
  | "reddit"
  | "product_hunt"
  | "x"
  | "search"
  | "direct"
  | "referral";

export type Attribution = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  ref: string | null;
  channel: AcquisitionChannel;
  landingPath: string | null;
  capturedAtMs: number | null;
};

const MAX_VALUE = 120;
const MAX_PATH = 200;

function bounded(value: string | null | undefined, max = MAX_VALUE): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** The UTM/ref fields present in a URL's query string. Never throws. */
export function parseAttribution(
  href: string | null | undefined,
): Pick<Attribution, "source" | "medium" | "campaign" | "term" | "content" | "ref" | "landingPath"> {
  const empty = {
    source: null,
    medium: null,
    campaign: null,
    term: null,
    content: null,
    ref: null,
    landingPath: null,
  };
  if (typeof href !== "string" || href.length === 0) return empty;
  let url: URL;
  try {
    url = new URL(href, "https://grynd.local");
  } catch {
    return empty;
  }
  if (url.origin !== "https://grynd.local" && !/^https?:/i.test(href)) return empty;
  const read = (key: string) => bounded(url.searchParams.get(key));
  return {
    source: read("utm_source"),
    medium: read("utm_medium"),
    campaign: read("utm_campaign"),
    term: read("utm_term"),
    content: read("utm_content"),
    ref: read("ref"),
    // The path only: a query string can carry a token that must not be stored.
    landingPath: bounded(url.pathname, MAX_PATH),
  };
}

const HOST_CHANNELS: ReadonlyArray<[RegExp, AcquisitionChannel]> = [
  [/(^|\.)tiktok\.com$|(^|\.)tiktok\.com\//i, "tiktok"],
  [/(^|\.)instagram\.com$|(^|\.)ig\.me$/i, "instagram"],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, "youtube"],
  [/(^|\.)reddit\.com$|(^|\.)redd\.it$/i, "reddit"],
  [/(^|\.)producthunt\.com$/i, "product_hunt"],
  [/(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)t\.co$/i, "x"],
  [/(^|\.)google\.[a-z.]+$|(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|(^|\.)search\.brave\.com$|(^|\.)ecosia\.org$/i, "search"],
];

function channelFromHost(host: string | null | undefined): AcquisitionChannel | null {
  if (!host) return null;
  const lower = host.toLowerCase();
  for (const [pattern, channel] of HOST_CHANNELS) {
    if (pattern.test(lower)) return channel;
  }
  return null;
}

/** A source string (`tiktok`, `ig`, `product hunt`, …) → channel. */
function channelFromSource(source: string | null | undefined): AcquisitionChannel | null {
  if (!source) return null;
  const value = source.toLowerCase().replace(/[\s-]+/g, "_");
  if (/tiktok/.test(value)) return "tiktok";
  if (/instagram|^ig$/.test(value)) return "instagram";
  if (/youtube|youtu/.test(value)) return "youtube";
  if (/reddit/.test(value)) return "reddit";
  if (/product_?hunt/.test(value)) return "product_hunt";
  if (/^(x|twitter|t_co)$/.test(value)) return "x";
  if (/google|bing|duckduckgo|search|organic/.test(value)) return "search";
  return null;
}

/**
 * The reporting channel for a touch.
 *
 * `utm_source` wins when it names a channel; otherwise the external referrer
 * host decides. A same-origin referrer with no source is DIRECT (an internal
 * navigation is not an acquisition), and an unknown external host is a
 * REFERRAL — never silently folded into direct, or those visitors disappear
 * from the report.
 */
export function classifyChannel({
  source = null,
  medium = null,
  referrer = null,
}: {
  source?: string | null;
  medium?: string | null;
  referrer?: string | null;
}): AcquisitionChannel {
  const bySource = channelFromSource(source);
  if (bySource) return bySource;

  let host: string | null = null;
  if (referrer) {
    try {
      const url = new URL(referrer);
      host = url.hostname;
      if (/grynd/i.test(host)) host = null;
    } catch {
      host = null;
    }
  }
  const byHost = channelFromHost(host);
  if (byHost) return byHost;
  if (host) return "referral";
  if (source || /cpc|paid|ppc|display/i.test(medium ?? "")) return "referral";
  return "direct";
}

/**
 * Fill gaps in the stored first touch from a new observation. Existing values
 * are preserved exactly; only nulls are filled. Returns a new object.
 */
export function mergeFirstTouch(
  stored: Attribution | null | undefined,
  incoming: Partial<Attribution> | null | undefined,
): Attribution | null {
  if (!stored && !incoming) return null;
  const base: Attribution = stored ?? {
    source: null,
    medium: null,
    campaign: null,
    term: null,
    content: null,
    ref: null,
    channel: "direct",
    landingPath: null,
    capturedAtMs: null,
  };
  const pick = (key: keyof Attribution) => base[key] ?? incoming?.[key] ?? null;

  // `direct` is the ABSENCE of a channel, not an observation: let a later,
  // tagged visit upgrade it. Every real channel is sticky.
  const channel =
    base.channel !== "direct"
      ? base.channel
      : incoming?.channel && incoming.channel !== "direct"
        ? incoming.channel
        : base.channel;

  return {
    source: pick("source") as string | null,
    medium: pick("medium") as string | null,
    campaign: pick("campaign") as string | null,
    term: pick("term") as string | null,
    content: pick("content") as string | null,
    ref: pick("ref") as string | null,
    channel,
    landingPath: pick("landingPath") as string | null,
    capturedAtMs: base.capturedAtMs ?? incoming?.capturedAtMs ?? null,
  };
}

/** Coerce stored JSON into an Attribution, or null when it is unusable. */
export function readStoredAttribution(raw: string | null | undefined): Attribution | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Attribution>;
    if (!parsed || typeof parsed !== "object") return null;
    const channels: AcquisitionChannel[] = [
      "tiktok",
      "instagram",
      "youtube",
      "reddit",
      "product_hunt",
      "x",
      "search",
      "direct",
      "referral",
    ];
    return {
      source: bounded(parsed.source),
      medium: bounded(parsed.medium),
      campaign: bounded(parsed.campaign),
      term: bounded(parsed.term),
      content: bounded(parsed.content),
      ref: bounded(parsed.ref),
      channel: channels.includes(parsed.channel as AcquisitionChannel)
        ? (parsed.channel as AcquisitionChannel)
        : "referral",
      landingPath: bounded(parsed.landingPath, MAX_PATH),
      capturedAtMs:
        typeof parsed.capturedAtMs === "number" && Number.isFinite(parsed.capturedAtMs)
          ? parsed.capturedAtMs
          : null,
    };
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored first touch, or null. Never throws. */
export function getFirstTouch(): Attribution | null {
  return readStoredAttribution(storage()?.getItem(ATTRIBUTION_STORAGE_KEY));
}

/**
 * Observe the current page and persist the merged first touch.
 *
 * Called on every page mount: the FIRST observation wins, a later tagged visit
 * only fills gaps (and may upgrade a bare `direct`). Returns the resulting
 * first touch so the caller can register it on events.
 */
export function captureFirstTouch(
  {
    href,
    referrer,
    nowMs = Date.now(),
  }: { href?: string | null; referrer?: string | null; nowMs?: number } = {},
): Attribution | null {
  const store = storage();
  if (!store) return null;

  const pageHref =
    href ?? (typeof window !== "undefined" ? window.location.href : null);
  const pageReferrer =
    referrer ?? (typeof document !== "undefined" ? document.referrer : null);
  const parsed = parseAttribution(pageHref);
  const incoming: Partial<Attribution> = {
    ...parsed,
    channel: classifyChannel({
      source: parsed.source,
      medium: parsed.medium,
      referrer: pageReferrer,
    }),
    capturedAtMs: nowMs,
  };

  const stored = readStoredAttribution(store.getItem(ATTRIBUTION_STORAGE_KEY));
  // A first observation with nothing to say (no source, direct, internal
  // navigation) is not worth persisting — it would freeze "direct" forever.
  const worthStoring =
    Boolean(stored) ||
    Boolean(incoming.source) ||
    Boolean(incoming.ref) ||
    (incoming.channel !== null && incoming.channel !== "direct");

  if (!worthStoring) return null;

  const merged = mergeFirstTouch(stored, incoming);
  if (!merged) return null;
  try {
    store.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Quota/blocked storage: the merged value is still returned.
  }
  return merged;
}

/** Event/person properties for the first touch. No personal data. */
export function attributionProperties(
  touch: Attribution | null | undefined,
): Record<string, string | number> {
  if (!touch) return {};
  const props: Record<string, string | number> = { acquisition_channel: touch.channel };
  if (touch.source) props.acquisition_source = touch.source;
  if (touch.medium) props.acquisition_medium = touch.medium;
  if (touch.campaign) props.acquisition_campaign = touch.campaign;
  if (touch.landingPath) props.acquisition_landing_path = touch.landingPath;
  if (touch.capturedAtMs) props.acquisition_first_seen_ms = touch.capturedAtMs;
  return props;
}
