// src/lib/ads.ts
//
// GRYND advertising configuration — the ONE place ad-provider values live.
//
// WHY THIS IS A SEPARATE MODULE
// Every ad surface (the loader and each slot) reads its identifiers from here,
// and nothing else in the app knows the provider. Swapping AdSense for another
// network means writing a new loader/renderer and changing this file — no page
// changes at all. That is the whole point of keeping `AdSlot` as the reusable
// abstraction.
//
// EVERYTHING IS ENVIRONMENT-BASED, AND NOTHING IS FAKED
//   * NEXT_PUBLIC_ADSENSE_CLIENT      — the publisher id (`ca-pub-…`).
//   * NEXT_PUBLIC_ADSENSE_SLOT_<PLACEMENT> — the numeric ad-unit id for each
//     placement (HOME, HUB, LEADERBOARD, PROFILE).
//   * NEXT_PUBLIC_ADSENSE_ENABLED     — set to "false" to switch ads off
//     entirely without removing any code.
//
// A placement with NO configured unit id renders NOTHING. There are no
// placeholder/fake slot ids anywhere in this repo, and no default unit is
// invented, so an unconfigured deploy simply shows no ads instead of shipping a
// broken `<ins>` that AdSense reports as an error. The publisher id likewise
// must look real (`ca-pub-` + 16 digits) or the tag is not emitted at all.
//
// The built-in publisher fallback below is NOT a placeholder: it is the
// publisher id this property is already authorised under (it is published
// verbatim in public/ads.txt), so a deploy that forgets the env var still
// serves the correct seller instead of breaking ads.txt reconciliation.
//
// Client- and server-safe: no imports that touch the database, Stripe or Clerk.

/** The publisher this property is registered under (see public/ads.txt). */
export const DEFAULT_ADSENSE_PUBLISHER_ID = "ca-pub-4903728316211815";

const PUBLISHER_ID_PATTERN = /^ca-pub-\d{16}$/;
const SLOT_ID_PATTERN = /^\d{4,20}$/;

/**
 * `ca-pub-1234567890123456` → itself; anything that isn't a real id → null.
 *
 * A malformed value is rejected so a typo can never emit a broken tag. Obvious
 * placeholders are rejected too (`ca-pub-000…0`, `ca-pub-111…1` …) — those are
 * documentation dummies, not a publisher, and emitting one would bill/report
 * against something that isn't ours.
 */
export function normalizePublisherId(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!PUBLISHER_ID_PATTERN.test(trimmed)) return null;
  const digits = trimmed.slice("ca-pub-".length);
  if (/^(\d)\1*$/.test(digits)) return null; // all-same-digit placeholder
  return trimmed;
}

/** True when the visitor's build/deploy should render ads at all. */
export function adsEnabled(): boolean {
  return (process.env.NEXT_PUBLIC_ADSENSE_ENABLED ?? "").trim().toLowerCase() !== "false";
}

/**
 * The publisher id for this deploy: the env value when it is well-formed,
 * otherwise the id the property is already authorised under.
 */
export function adsensePublisherId(): string {
  return (
    normalizePublisherId(process.env.NEXT_PUBLIC_ADSENSE_CLIENT) ??
    DEFAULT_ADSENSE_PUBLISHER_ID
  );
}

/**
 * Every place an ad may appear. Deliberately NON-GAME surfaces only — the ad
 * model is "monetise browsing, never wagering in progress", so a placement key
 * existing at all is a decision that the page is not gameplay.
 */
export type AdPlacement = "home" | "hub" | "leaderboard" | "profile";

/** Placement → the env var that carries its ad-unit id (documented, not faked). */
export const AD_PLACEMENT_ENV: Record<AdPlacement, string> = {
  home: "NEXT_PUBLIC_ADSENSE_SLOT_HOME",
  hub: "NEXT_PUBLIC_ADSENSE_SLOT_HUB",
  leaderboard: "NEXT_PUBLIC_ADSENSE_SLOT_LEADERBOARD",
  profile: "NEXT_PUBLIC_ADSENSE_SLOT_PROFILE",
};

function rawSlotValue(placement: AdPlacement): string | undefined {
  switch (placement) {
    case "home":
      return process.env.NEXT_PUBLIC_ADSENSE_SLOT_HOME;
    case "hub":
      return process.env.NEXT_PUBLIC_ADSENSE_SLOT_HUB;
    case "leaderboard":
      return process.env.NEXT_PUBLIC_ADSENSE_SLOT_LEADERBOARD;
    case "profile":
      return process.env.NEXT_PUBLIC_ADSENSE_SLOT_PROFILE;
    default:
      return undefined;
  }
}

/**
 * The configured ad-unit id for a placement, or null when this deploy has no
 * unit for it. Null means "render nothing" — never a made-up id.
 */
export function adUnitId(placement: AdPlacement): string | null {
  const trimmed = (rawSlotValue(placement) ?? "").trim();
  return SLOT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** True when at least one placement has a real unit id configured. */
export function hasAnyConfiguredAdUnit(): boolean {
  return (Object.keys(AD_PLACEMENT_ENV) as AdPlacement[]).some(
    (placement) => adUnitId(placement) !== null
  );
}

// ── Monetag ─────────────────────────────────────────────────────────────────
// The SECOND provider, configured on exactly the same terms as the first: one
// loader, per browsing page, never inside gameplay, never for a GRYND PRO
// member (the entitlement is decided by lib/adEntitlement.ts, not by a flag the
// client can send). See components/MonetagScript.tsx.
//
// Everything below is PUBLIC: the zone id is the `data-zone` attribute of a
// script every visitor downloads, so DEFAULT_MONETAG_ZONE is not a placeholder
// invented here — it is the zone this property is registered under, exactly
// like DEFAULT_ADSENSE_PUBLISHER_ID above.
//
//   * NEXT_PUBLIC_MONETAG_ZONE    — the zone id to load (digits).
//   * NEXT_PUBLIC_MONETAG_ENABLED — "false" switches the provider off without
//     touching any page or component.

/** The Monetag MultiTag loader. Its `data-zone` value carries the zone id. */
export const MONETAG_TAG_SRC = "https://quge5.com/88/tag.min.js";

/** The zone this property is monetised under (from the Monetag dashboard). */
export const DEFAULT_MONETAG_ZONE = "295730";

const ZONE_ID_PATTERN = /^\d{4,12}$/;

/** True when this deploy should render Monetag ads at all. */
export function monetagEnabled(): boolean {
  return (
    (process.env.NEXT_PUBLIC_MONETAG_ENABLED ?? "").trim().toLowerCase() !==
    "false"
  );
}

/**
 * The zone id to load, or null when the configured value is unusable — a null
 * means the loader renders nothing rather than emitting a tag pointed at a zone
 * that isn't ours (a malformed zone would either 404 or, worse, load somebody
 * else's zone).
 */
export function monetagZoneId(): string | null {
  const trimmed =
    (process.env.NEXT_PUBLIC_MONETAG_ZONE ?? "").trim() || DEFAULT_MONETAG_ZONE;
  return ZONE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * The ad-network frame hosts the CSP has to allow for Monetag to paint.
 *
 * `script-src`, `img-src` and `connect-src` already allow all of `https:`, so
 * the tags themselves always load and always reach their API — but a Monetag
 * format renders its creative in a cross-origin FRAME, and `frame-src` is the
 * one directive the CSP names explicitly. These four host families come from
 * the zone's own configuration (the loader's host plus the extra format hosts
 * the zone returns), so they are the ones this property actually uses.
 */
export const MONETAG_FRAME_HOSTS = [
  "quge5.com",
  "auqot.com",
  "ekhay.com",
  "b3mny.com",
] as const;
