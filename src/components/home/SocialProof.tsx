// src/components/home/SocialProof.tsx
//
// THE TWO THIRD-PARTY PROOF LINKS ON THE HOME PAGE.
//
//   * Trustpilot — a first-party capsule that links to the verified
//     grynd.dedyn.io profile. It deliberately does NOT embed the Review
//     Collector TrustBox: that iframe paints its own white pill and ignores
//     `theme=dark` (the template is fixed by Trustpilot's generator), so on the
//     dark ground it read as a stray white rectangle. The capsule carries the
//     same verified review URL, in the page's own palette.
//   * Product Hunt — the official "featured" badge (see
//     ProductHuntBadge.tsx). A plain <a> around their SVG: no script, no
//     layout shift.
//
// Both are server-rendered markup, so a crawler receives the links. This stays a
// server component: it reads the Trustpilot config per request and ships no
// client JavaScript. If the Trustpilot ids are switched off
// (NEXT_PUBLIC_TRUSTPILOT_ENABLED=false) the capsule disappears; the Product
// Hunt badge is first-party markup and stays.
//
// The live TrustBox (real reviews, scores) still runs on /reviews and beside the
// PRO upsell — surfaces where a full review list is the point, not a strip.

import { getTrustpilotConfig } from "../../lib/trustpilot";
import ProductHuntBadge from "./ProductHuntBadge";

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
          <a
            href={trustpilot.reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex h-[52px] w-full max-w-[300px] items-center gap-3 rounded-full border border-white/12 bg-[#071223]/80 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xs transition-colors hover:border-[#00b67a]/45 hover:bg-[#081a2c]/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00b67a]/60"
          >
            <span
              aria-hidden="true"
              className="text-[17px] leading-none text-[#00b67a] drop-shadow-[0_0_6px_rgba(0,182,122,0.35)]"
            >
              ★
            </span>
            <span className="min-w-0 text-left">
              <span className="block text-[11px] font-black uppercase tracking-[0.16em] text-white/85">
                Trustpilot
              </span>
              <span className="block truncate text-[10px] font-medium text-white/40">
                Read player reviews
              </span>
            </span>
            <span
              aria-hidden="true"
              className="ml-auto text-xs text-white/30 transition-colors group-hover:text-[#00b67a]"
            >
              ↗
            </span>
          </a>
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
