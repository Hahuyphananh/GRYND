// src/components/home/SocialProof.tsx
//
// THE TWO THIRD-PARTY PROOF WIDGETS ON THE HOME PAGE.
//
//   * Trustpilot — the Review Collector TrustBox Trustpilot generated for the
//     verified grynd.dedyn.io profile. The snippet is Trustpilot's own: the
//     bootstrap loads from their CDN and the `.trustpilot-widget` div carries
//     their business unit, template and 52px height. The profile link is the
//     no-JavaScript fallback, exactly as their embed ships it.
//   * Product Hunt — the official "featured" badge, in the theme of the page
//     (see ProductHuntBadge.tsx). It is a plain <a> around their SVG, so it
//     needs no script and cannot slow the page down.
//
// Both are server-rendered markup, so the links and the TrustBox element are in
// the HTML a crawler receives; only Trustpilot's iframe is hydrated on the
// client (see components/trustpilot/TrustpilotWidget.tsx).
//
// A server component on purpose: it reads the Trustpilot config per request and
// ships no client JavaScript of its own. If the Trustpilot ids are ever switched
// off (NEXT_PUBLIC_TRUSTPILOT_ENABLED=false) the TrustBox disappears; the
// Product Hunt badge is first-party markup and stays.

import {
  TRUSTPILOT_REVIEW_COLLECTOR_HEIGHT,
  getTrustpilotConfig,
} from "../../lib/trustpilot";
import ProductHuntBadge from "./ProductHuntBadge";
import TrustpilotWidget from "../trustpilot/TrustpilotWidget";

export default function SocialProof() {
  const trustpilot = getTrustpilotConfig();

  return (
    <section
      data-testid="home-social-proof"
      aria-label="GRYND on Trustpilot and Product Hunt"
      className="mx-auto mt-12 w-full max-w-3xl px-1"
    >
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-center sm:gap-8">
        {trustpilot && (
          <div className="w-full max-w-[300px]">
            {/* Review Collector: Trustpilot's 52px strip, on the brand ground. */}
            <TrustpilotWidget
              businessUnitId={trustpilot.businessUnitId}
              templateId={trustpilot.templateId}
              domain={trustpilot.domain}
              height={TRUSTPILOT_REVIEW_COLLECTOR_HEIGHT}
            />
          </div>
        )}

        <ProductHuntBadge />
      </div>

      <p className="mt-4 text-center text-[11px] text-white/35">
        {trustpilot ? (
          <>
            Reviews live on Trustpilot.{" "}
            <a
              href={trustpilot.reviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 transition-colors hover:text-white/60"
            >
              Read the profile
            </a>
          </>
        ) : (
          "Find GRYND on Product Hunt."
        )}
      </p>
    </section>
  );
}
