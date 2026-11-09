"use client";

// src/components/portal/PortalHomeButton.tsx
//
// "Keep playing on GRYND" — shown ON the portal surface, after a match ends,
// only for the portals that offer it (lib/portal/home.ts, Poki today).
//
// ── WHEN IT APPEARS ───────────────────────────────────────────────────────
//
// A match has to FINISH. The games already announce that moment on
// PORTAL_MATCH_FINISHED_EVENT (PvpResultScreen and Battleship's own end card),
// which is the same beat the CrazyGames bridge uses for gameplayStop — so this
// adds no new per-game hook and no polling. Until then it renders nothing.
//
// ── HOW IT LEAVES ─────────────────────────────────────────────────────────
//
// A plain <a> to the public home page, `target="_blank"` with
// `rel="noopener noreferrer"`. Not `window.top.location` (cross-origin frames
// block it and it is a hostile thing to do to a portal's page), not a popup on a
// timer (blocked, and it would fire without the player asking).
//
// ── WHAT IT MUST NOT DO ───────────────────────────────────────────────────
//
// Cover the result, take focus, or follow the player around: it is a bottom
// sheet with a dismiss control, dismissable for this match only, and it never
// reopens after one dismissal. No identifier of any kind is passed — see
// portalHomeHref.

import { useCallback, useEffect, useState } from "react";
import { IconArrowRight, IconX } from "@tabler/icons-react";

import { useTranslation } from "../../hooks/useTranslation";
import { PORTAL_MATCH_FINISHED_EVENT } from "../../lib/portal/crazygames";
import { offersPortalHome, portalHomeHref } from "../../lib/portal/home";

export default function PortalHomeButton({ portal }: { portal?: string | null }) {
  const { t } = useTranslation();
  const [finished, setFinished] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const offered = offersPortalHome(portal);
  const href = offered && portal ? portalHomeHref(portal) : null;

  useEffect(() => {
    if (!offered) return undefined;
    const onFinished = () => setFinished(true);
    window.addEventListener(PORTAL_MATCH_FINISHED_EVENT, onFinished);
    return () => window.removeEventListener(PORTAL_MATCH_FINISHED_EVENT, onFinished);
  }, [offered]);

  const dismiss = useCallback(() => setDismissed(true), []);

  if (!offered || !href || !finished || dismissed) return null;

  return (
    <div
      data-testid="portal-home-button"
      role="region"
      aria-label={t("portal.home.aria", "Keep playing on GRYND")}
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-[#00e5ff]/30 bg-[#04122b]/95 px-3 py-3 backdrop-blur-xs"
    >
      <div className="mx-auto flex w-full max-w-md items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-black leading-tight text-white">
            {t("portal.home.title", "Want to keep playing?")}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-[#9dd8ff]/80">
            {t("portal.home.body", "More games, real opponents and your progress saved.")}
          </p>
        </div>

        <a
          href={href}
          data-testid="portal-home-link"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border-b-4 border-[#00a86b] bg-[#00ffa6] px-3 py-2 text-xs font-extrabold text-[#00231a] transition hover:brightness-110"
        >
          {t("portal.home.cta", "Play on GRYND")}
          <IconArrowRight size={14} aria-hidden="true" />
        </a>

        <button
          type="button"
          data-testid="portal-home-dismiss"
          onClick={dismiss}
          aria-label={t("portal.home.dismissAria", "Dismiss")}
          className="shrink-0 rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white/80"
        >
          <IconX size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
