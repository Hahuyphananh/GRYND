"use client";

// src/components/GryndProWidget.tsx
//
// The reusable GRYND PRO widget. It replaces the retired Daily Reward claim
// surface in the home page's bottom-right corner and can be dropped on any
// NON-GAMEPLAY page:
//
//   * free member  → the promotional card (branding, value prop, the existing
//                    PRO benefits, and the existing UpgradeProButton CTA, which
//                    links straight to /upgrade-pro instead of opening the modal
//                    — the widget is a pointer to the full offer, not a place to
//                    sell it),
//   * active member → a small "GRYND PRO" status card (no upsell),
//   * signed out    → nothing.
//
// The membership state is server-authoritative (useMembershipStatus →
// /api/membership/status), exactly like the rest of the GRYND PRO surfaces.
// No price is defined here — UpgradeProButton resolves it from the plan
// catalog, so there is one source of truth. The benefits listed are the
// canonical ones already defined in lib/membershipDisplay, so this component
// can never advertise a perk the product doesn't have. GRYND PRO grants no
// competitive advantage and this widget never appears inside gameplay.

import Link from "next/link";
import UpgradeProButton from "./UpgradeProButton";
import { useMembershipStatus } from "../lib/upgradePro";
import {
  PRO_PLAN_FALLBACK_PERKS,
  UPGRADE_PRO_PATH,
} from "../lib/membershipDisplay";

const POSITION_CLASS =
  "fixed right-4 bottom-16 z-50 w-72 max-w-[calc(100vw-2rem)]";

export default function GryndProWidget() {
  const { loaded, signedIn, active } = useMembershipStatus();

  // Unknown state or signed out: render nothing rather than flash the wrong
  // message. (The server is the only thing that can declare PRO.)
  if (!loaded || !signedIn) return null;

  if (active) {
    return (
      <div className={POSITION_CLASS}>
        <div className="rounded-xl border border-emerald-400/50 bg-black/80 px-4 py-3 text-right shadow-[0_0_20px_rgba(52,211,153,0.2)] backdrop-blur-md">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-300">
            ✦ GRYND PRO
          </p>
          <p className="mt-0.5 text-xs text-[#9dd8ff]">
            Active — ad-free with advanced stats &amp; analytics.
          </p>
          <Link
            href={UPGRADE_PRO_PATH}
            className="mt-1 inline-block text-xs font-semibold text-[#f5ff3b] hover:text-yellow-300"
          >
            Manage membership →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={POSITION_CLASS}>
      <div className="rounded-xl border border-[#f5ff3b]/40 bg-gradient-to-b from-[#0a214d]/95 to-[#08142f]/95 p-4 shadow-[0_0_25px_rgba(245,255,59,0.15)] backdrop-blur-md">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#00e5ff]">
          ✦ Membership
        </p>
        <h3 className="mt-0.5 text-lg font-black text-[#f5ff3b]">GRYND PRO</h3>
        <ul className="mt-2 space-y-1 text-xs text-[#d8fbff]">
          {PRO_PLAN_FALLBACK_PERKS.map((perk) => (
            <li key={perk} className="flex items-start gap-1.5">
              <span aria-hidden className="text-[#00ffa6]">
                ✓
              </span>
              <span>{perk}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-[#9dd8ff]/80">
          Convenience only — never an advantage. Every game, rank and reward
          stays free.
        </p>
        <div className="mt-3">
          <UpgradeProButton className="w-full" linkToPage />
        </div>
      </div>
    </div>
  );
}
