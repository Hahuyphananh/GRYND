// The Trustpilot surface on /reviews: the TrustBox (what players wrote there)
// plus the review-collection link (where a visitor writes one).
//
// A server component, so the identifiers are read per request and the bootstrap
// script is not part of any bundle. It renders NOTHING when the deploy has no
// usable Trustpilot setup — see src/lib/trustpilot.ts. That matters twice over:
// an unconfigured deploy must not show an empty card, and it must not send
// players to a Trustpilot profile that does not exist.

import { getTrustpilotConfig } from "../../lib/trustpilot";
import TrustpilotWidget from "./TrustpilotWidget";

export default function TrustpilotPanel() {
  const config = getTrustpilotConfig();
  if (!config) return null;

  return (
    <section
      aria-labelledby="trustpilot-heading"
      className="mt-16 rounded-2xl border border-white/10 bg-[#040d24]/60 p-6 sm:p-8"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2
            id="trustpilot-heading"
            className="text-xl font-bold text-white sm:text-2xl"
          >
            GRYND on Trustpilot
          </h2>
          <p className="mt-1 text-sm text-white/60">
            Read what players wrote there, or add your own review.
          </p>
        </div>

        {/* Review collection: Trustpilot's own evaluate page is the verified
            way for a visitor to leave a review, and it ties the review to the
            business domain this site proved ownership of. */}
        <a
          href={config.evaluateUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#00e5ff]/30 bg-[#040d24]/70 px-4 py-2 text-sm font-semibold text-[#c9f7ff]/80 transition hover:border-[#00e5ff]/60 hover:bg-[#00e5ff]/10 hover:text-white"
        >
          Write a review
          <span aria-hidden="true">↗</span>
        </a>
      </div>

      <div className="mt-6">
        <TrustpilotWidget
          businessUnitId={config.businessUnitId}
          templateId={config.templateId}
          domain={config.domain}
        />
      </div>

      <p className="mt-4 text-xs text-white/40">
        Reviews on Trustpilot are written by players on Trustpilot, not moderated
        by GRYND.{" "}
        <a
          href={config.reviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-white/70"
        >
          See the profile
        </a>
      </p>
    </section>
  );
}
