"use client";

// src/components/QuestNavBadge.tsx
//
// The Games hub link in the navbar carries a small badge while the player has
// quests they could claim. It is a FLAG, not a surface: it says "there are coins
// waiting", and the corner widget on the hub (components/QuestWidget) is where
// they are actually claimed.
//
// ── Why the nav ────────────────────────────────────────────────────────────
//
// Quest progress only moves on a settled human-vs-human match, and the first
// thing a player does after one is navigate. A badge on the hub link is the one
// signal that survives that navigation, so a completed quest is noticed without
// visiting /rewards to look for it.
//
// ── One source of truth ────────────────────────────────────────────────────
//
// The count comes from `useQuests` — the same read the /rewards board and the
// corner widget use — so the badge can never advertise a quest the claim route
// would refuse. `claimable` is the server's flag (complete AND unclaimed).
//
// The nav mounts on EVERY page, so this instance opts out of the hook's
// focus/visibility re-read: a per-page mount already re-reads on navigation, and
// a claim (or a settled match that completes a quest) changes the balance and
// announces it — that event is what keeps the flag honest without a board read
// on every alt-tab.

import { useEffect } from "react";
import { useQuests } from "../hooks/useQuests";
import { useTranslation } from "../hooks/useTranslation";
import { COIN_BALANCE_EVENT } from "../hooks/useCoinBalance";

export default function QuestNavBadge() {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn, board, load } = useQuests({ autoRefresh: false });

  useEffect(() => {
    if (!isSignedIn) return undefined;
    const refresh = () => void load();
    window.addEventListener(COIN_BALANCE_EVENT, refresh);
    return () => window.removeEventListener(COIN_BALANCE_EVENT, refresh);
  }, [isSignedIn, load]);

  if (!isLoaded || !isSignedIn || !board) return null;

  const claimable = [...board.daily, ...board.weekly].filter(
    (quest) => quest.claimable,
  ).length;
  // Nothing to flag — and no zero badge, which would be a permanent lie.
  if (claimable === 0) return null;

  const label = t("quests.badgeLabel", { count: claimable });

  return (
    <span
      data-testid="quest-nav-badge"
      data-count={claimable}
      title={label}
      aria-label={label}
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-[#f5ff3b]/60 bg-[#f5ff3b] px-1 text-[10px] font-black leading-none text-[#1f1700] shadow-[0_0_10px_rgba(245,255,59,0.45)]"
    >
      <span aria-hidden="true">{claimable > 9 ? "9+" : claimable}</span>
    </span>
  );
}
