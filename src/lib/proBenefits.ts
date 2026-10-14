// src/lib/proBenefits.ts
//
// WHAT GRYND PRO SELLS — the approved benefit list, and which of it is LIVE.
//
// THE SINGLE SOURCE OF TRUTH. Before this module the same list existed four
// times (the upgrade page's `BENEFIT_KEYS`, the fallback perk constants in
// membershipDisplay, the plan's `perks` row in the database, and the Stripe
// product description), which is how copy drifts and how a permission that no
// longer exists stays on the price tag. Every surface now derives from this
// file.
//
// ── AVAILABILITY IS THE POINT ─────────────────────────────────────────────
//
// A benefit may only be ADVERTISED once the entitlement behind it actually
// exists and is enforced server-side. So each benefit carries its state:
//
//   * `available` — shipped AND enforced today, safe to advertise now.
//   * `planned`   — approved product direction, NOT built yet. It is recorded
//                   here (and translated, and tested) so the surface that
//                   implements it only has to flip this value — but it is NOT
//                   rendered on the offer until then, because advertising a
//                   feature that does not exist is the exact failure this
//                   module is here to prevent. `advertisedProBenefits()` is the
//                   only list a marketing surface may render.
//
// The three `planned` entries (statistics/analytics graphs, extended
// leaderboards with progression graphs, private custom rooms) are scheduled to
// be implemented in follow-up work; when each lands, move it to `available` in
// the same change that adds its server-authoritative check and its tests.
//
// ── RETRACTED CLAIMS ──────────────────────────────────────────────────────
//
// `RETRACTED_PRO_CLAIMS` records what GRYND PRO must NOT advertise, with the
// reason, so the same claim cannot creep back in through a copy edit or a
// catalog row. The test suite asserts none of these strings appears on an offer
// surface.
//
// No server imports: the upgrade page, the modal and the widget are client
// components.

/** The approved benefit ids, in DISPLAY order (the order the offer shows them). */
export const PRO_BENEFIT_IDS = [
  "ad_free",
  "analytics",
  "leaderboards",
  "private_rooms",
  "matchmaking",
] as const;

export type ProBenefitId = (typeof PRO_BENEFIT_IDS)[number];

/** `available` = shipped and enforced today; `planned` = not built yet. */
export type ProBenefitAvailability = "available" | "planned";

export type ProBenefit = {
  id: ProBenefitId;
  availability: ProBenefitAvailability;
};

/**
 * The approved offer, in display order.
 *
 * `ad_free`      — the AdSense loader and every ad unit are skipped for a
 *                  verified active member (src/lib/adEntitlement.ts), enforced
 *                  in the server-rendered response, not by hiding a div.
 *
 * `matchmaking`  — the queue worker prefers an active member ONLY as a
 *                  tie-break between already skill-compatible candidates; it
 *                  never widens the skill window and never changes a result
 *                  (src/lib/quickQueueWorker.ts + getActiveMemberIds).
 *
 * The remaining three are approved but NOT enforced yet — see the module note.
 */
export const PRO_BENEFITS: readonly ProBenefit[] = [
  { id: "ad_free", availability: "available" },
  { id: "analytics", availability: "planned" },
  { id: "leaderboards", availability: "planned" },
  { id: "private_rooms", availability: "planned" },
  { id: "matchmaking", availability: "available" },
];

/**
 * The ONLY benefits a marketing surface (upgrade page, modal, widget, Stripe
 * product copy) may render. Never render `PRO_BENEFITS` directly — a planned
 * benefit must not be advertised as though it were included today.
 */
export const ADVERTISED_PRO_BENEFITS: readonly ProBenefit[] = PRO_BENEFITS.filter(
  (benefit) => benefit.availability === "available",
);

/** The advertised benefit ids, in display order. */
export const ADVERTISED_PRO_BENEFIT_IDS: readonly ProBenefitId[] =
  ADVERTISED_PRO_BENEFITS.map((benefit) => benefit.id);

/** The approved ids still to be built, in display order. */
export const PLANNED_PRO_BENEFIT_IDS: readonly ProBenefitId[] = PRO_BENEFITS.filter(
  (benefit) => benefit.availability === "planned",
).map((benefit) => benefit.id);

/**
 * The canonical English wording of each benefit.
 *
 * Used (a) for the plan's fallback perk lines, which are plain strings rather
 * than translation keys, and (b) as the reference the `pro.benefit.*` keys in
 * every locale are written against. A surface with a translation provider
 * should render `t("pro.benefit.<id>")` instead of these strings; anything
 * rendering a raw string (the Stripe product copy, the DB plan row) uses these.
 */
export const PRO_BENEFIT_LABELS: Record<ProBenefitId, string> = {
  ad_free: "Ad-free browsing and gaming",
  analytics: "Advanced statistics and performance analytics, including graphs",
  leaderboards:
    "Extended leaderboard access, with graphs of your ranking over time",
  private_rooms: "Create private custom rooms",
  matchmaking:
    "Priority matchmaking — a fair queue tie-break, never a skill advantage",
};

/**
 * One English perk line per ADVERTISED benefit, in display order — the fallback
 * plan's perk list and the membership widget's bullet list.
 */
export const ADVERTISED_PRO_PERKS: readonly string[] = ADVERTISED_PRO_BENEFITS.map(
  (benefit) => PRO_BENEFIT_LABELS[benefit.id],
);

/**
 * Claims GRYND PRO must never advertise again, each with the reason it was
 * removed. Kept in code (rather than only in a changelog) so the test suite can
 * fail if one of these strings returns to an offer surface.
 */
export const RETRACTED_PRO_CLAIMS: readonly {
  /** The phrase (or fragment) that must not appear in offer copy. */
  claim: string;
  reason: string;
}[] = [
  {
    claim: "Custom chat color",
    // NOTE: the profile screen still prompts for this against a LIVE
    // server-side gate (`/api/user/chat-color`). It is excluded from the offer
    // because GRYND does not sell customization as a membership benefit — see
    // the audit note in the changelog entry.
    reason:
      "Profile customization (chat colour, profile accent) is not sold as an exclusive membership benefit.",
  },
  {
    claim: "profile accent",
    reason:
      "Profile customization is not advertised as a membership benefit — customization is not gated to members on the offer.",
  },
  {
    claim: "Priority support",
    reason: "There is no priority support service to provide.",
  },
  {
    claim: "Detailed match history",
    reason:
      "No detailed match-history feature exists; the existing match history stays free for everyone.",
  },
];

/** Is this value one of the approved benefit ids? */
export function isProBenefitId(value: unknown): value is ProBenefitId {
  return (
    typeof value === "string" && (PRO_BENEFIT_IDS as readonly string[]).includes(value)
  );
}

/**
 * The benefit ids a surface may advertise, optionally filtered by availability
 * (the default is the advertised set). Pure, so the rule is testable without
 * rendering a component.
 */
export function proBenefitIds(
  availability: ProBenefitAvailability = "available",
): ProBenefitId[] {
  return PRO_BENEFITS.filter((benefit) => benefit.availability === availability).map(
    (benefit) => benefit.id,
  );
}
