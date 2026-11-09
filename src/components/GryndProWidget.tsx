"use client";

/**
 * src/components/GryndProWidget.tsx
 *
 * THE GRYND PRO floating card, restored to the bottom-right corner of the site.
 *
 * It is the widget the casino hub and the game landing pages originally mounted
 * (recovered from this file's own history, `git log -- src/components/
 * GryndProWidget.tsx`), now mounted ONCE in `SiteChrome` so it follows the
 * visitor across every eligible page instead of existing only where a page
 * remembered to render it.
 *
 * WHAT IT SAYS
 *   free member  → GRYND PRO branding, the canonical perks, and the existing
 *                  `UpgradeProButton` CTA (which links to /upgrade-pro instead
 *                  of opening the modal — a card is a pointer to the offer, not
 *                  a second place to sell it).
 *   active PRO   → NOTHING. A paying member is not a prospect.
 *   signed out   → nothing (the existing behaviour: there is no account to
 *                  upgrade, and a sign-up funnel belongs on the marketing pages).
 *
 * WHAT IT DOES NOT DO
 *   • It defines no price and no Stripe call: `UpgradeProButton` resolves the
 *     price from the plan catalog and reuses the existing Checkout/Portal code,
 *     so there is one source of truth for money.
 *   • It never decides membership locally — `useMembershipStatus` reads the
 *     server, and until it answers the card renders nothing.
 *   • It cannot appear over a live board: `shouldShowProWidget` in
 *     lib/proWidget.ts excludes gameplay, the upgrade page and the auth pages,
 *     and `SiteChrome` is where that check is applied.
 *   • It does not re-ask in the same browsing session once dismissed
 *     (sessionStorage, see lib/proWidget.ts).
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import UpgradeProButton from "./UpgradeProButton";
import { useMembershipStatus } from "../lib/upgradePro";
import {
  PRO_PLAN_FALLBACK_PERKS,
  UPGRADE_PRO_PATH,
} from "../lib/membershipDisplay";
import {
  dismissProWidget,
  isProWidgetDismissed,
} from "../lib/proWidget";

/**
 * Bottom-right on every size. On a phone it sits ABOVE the mobile sticky CTA
 * (which owns the bottom edge) and is offset by the safe-area inset, so it can
 * never cover a notch or the site's own primary button. `z-40` keeps it under
 * the chat bubble (z-70), the cookie banner (z-60) and the sticky CTA (z-50).
 */
const POSITION_CLASS =
  "fixed right-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 w-[min(18rem,calc(100vw-1.5rem))] md:bottom-4 md:right-4";

export default function GryndProWidget() {
  const { loaded, signedIn, active } = useMembershipStatus();
  const [dismissed, setDismissed] = useState(false);

  // sessionStorage is read after mount: rendering it during the server pass
  // would mean a card that has been dismissed flashes back on every navigation.
  useEffect(() => {
    setDismissed(isProWidgetDismissed());
  }, []);

  const close = () => {
    dismissProWidget();
    setDismissed(true);
  };

  // Unknown state, signed out, an active member, or a dismissed session: the
  // card simply is not there.
  if (!loaded || !signedIn || active || dismissed) return null;

  return (
    <aside className={POSITION_CLASS} aria-label="GRYND PRO" data-testid="grynd-pro-widget">
      <div className="relative rounded-xl border border-[#f5ff3b]/40 bg-linear-to-b from-[#0a214d]/95 to-[#08142f]/95 p-4 shadow-[0_0_25px_rgba(245,255,59,0.15)] backdrop-blur-md">
        <button
          type="button"
          onClick={close}
          aria-label="Dismiss the GRYND PRO offer"
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          ×
        </button>

        <p className="pr-6 text-[11px] font-bold uppercase tracking-[0.2em] text-[#00e5ff]">
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
        <Link
          href={UPGRADE_PRO_PATH}
          className="mt-2 block text-center text-[11px] text-[#9dd8ff]/80 underline-offset-2 hover:text-[#f5ff3b] hover:underline"
        >
          See what PRO includes
        </Link>
      </div>
    </aside>
  );
}
