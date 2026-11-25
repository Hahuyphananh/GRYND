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
// The remaining `planned` entry (extended leaderboards with progression graphs)
// is scheduled for follow-up work; when it lands, move it to `available` in the
// same change that adds its server-authoritative check and its tests.
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
  "analysis_unlimited",
  "analytics",
  "daily_archive",
  "social_status",
  "ad_free",
  "leaderboards",
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
 * `social_status` — the membership is VISIBLE. An active member wears a PRO
 *                  badge (FOUNDER inside the founding window) on every
 *                  leaderboard row and in chat, resolved server-side from the
 *                  subscription row (src/lib/proStatus.ts), and may equip the
 *                  PRO-only profile frames and table themes (the catalog's
 *                  `pro_only` entries, refused for a non-member in
 *                  src/lib/cosmetics.ts / the board-theme route). It grants no
 *                  competitive advantage and no other cosmetic is gated.
 *
 * `analysis_unlimited` — a free account gets FREE_ANALYSES_PER_DAY (3) fresh
 *                  Game Review analyses per UTC day, per identity; an active
 *                  member is never counted (src/lib/solitaire-duel/
 *                  analysisAllowance.ts, consumed by both review routes).
 *
 * `analytics`    — the performance dashboard (win rates, Elo and trophy
 *                  progression, rank history) is served only to an active
 *                  member: /api/stats/performance answers a non-member with
 *                  `{ pro: false, locked: true }` and no figures.
 *
 * `daily_archive` — the list of past Daily deals is served only to an active
 *                  member: /api/solitaire/daily/archive resolves the tier from
 *                  the subscription row and answers a free caller with
 *                  `{ locked: true, days: [] }` and no deal dates. Today's
 *                  challenge stays free.
 *
 * Private custom rooms remain enforced (POST /api/rooms is still PRO-only) but
 * are not part of the current value box, so they are not advertised here.
 *
 * Priority matchmaking is deliberately NOT sold. The queue worker still runs
 * its bounded member preference (src/lib/quickQueueWorker.ts), but advertising
 * it on a growing site tells a player the queues are thin enough that a
 * tie-break is worth paying for. It stays out of the offer until there are
 * enough concurrent players that the preference is invisible.
 */
export const PRO_BENEFITS: readonly ProBenefit[] = [
  // Strongest paid benefit first: unlimited analysis is the reason a player
  // upgrades, not the ad removal every site already offers.
  { id: "analysis_unlimited", availability: "available" },
  { id: "analytics", availability: "available" },
  { id: "daily_archive", availability: "available" },
  { id: "social_status", availability: "available" },
  { id: "ad_free", availability: "available" },
  { id: "leaderboards", availability: "planned" },
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
  analysis_unlimited:
    "Unlimited Match Replays & Analysis — Scrub through every move, spot time-loss spikes, and review optimal lines after every game.",
  analytics:
    "Deep Performance Graphs — Track Elo trends, win rates by game mode, and speed benchmarks over time.",
  daily_archive:
    "Daily Challenge Archive — Replay any past Daily Deal or seed you missed and compare against the global board.",
  social_status:
    "PRO Leaderboard Badge & Founder Flair — Stand out in lobbies and rankings with an exclusive PRO badge and board theme.",
  ad_free:
    "100% Ad-Free Experience — Zero banners or interruptions while you play.",
  leaderboards:
    "Extended leaderboard access, with graphs of your ranking over time",
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
