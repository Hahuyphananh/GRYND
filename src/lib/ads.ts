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
//     placement (HOME, HUB, LEADERBOARD, PROFILE, BATTLEPASS).
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
export type AdPlacement = "home" | "hub" | "leaderboard" | "profile" | "battlepass";

/** Placement → the env var that carries its ad-unit id (documented, not faked). */
export const AD_PLACEMENT_ENV: Record<AdPlacement, string> = {
  home: "NEXT_PUBLIC_ADSENSE_SLOT_HOME",
  hub: "NEXT_PUBLIC_ADSENSE_SLOT_HUB",
  leaderboard: "NEXT_PUBLIC_ADSENSE_SLOT_LEADERBOARD",
  profile: "NEXT_PUBLIC_ADSENSE_SLOT_PROFILE",
  battlepass: "NEXT_PUBLIC_ADSENSE_SLOT_BATTLEPASS",
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
    case "battlepass":
      return process.env.NEXT_PUBLIC_ADSENSE_SLOT_BATTLEPASS;
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
