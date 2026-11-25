"use client";

// src/components/StreakMilestonesCard.tsx
//
// The streak progression card on /rewards.
//
// ── What this is ────────────────────────────────────────────────────────────
//
// A view over `GET /api/user/daily-streak`: the current streak, the best
// streak, the title the current streak has earned, the next milestone and the
// full threshold list with achieved / next / locked states. There is no reward
// to claim and no token amount anywhere on this surface.
//
// ── Why it is a progression system, not a daily login reward ────────────────
//
// The streak advances when a player FINISHES A GAME — the authoritative
// completion route credits the day through the shared streak writer — and
// never from opening the site. One credit per calendar day, so several games
// on the same day cannot double-count. Missing a day resets the current
// streak to 1; the best streak and every title already earned stay put.
//
// The milestone arithmetic lives in src/lib/streakTitles.js and is applied by
// the read endpoint, so this component renders numbers rather than deriving
// them.

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconCheck, IconRefresh } from "@tabler/icons-react";
import { useDailyStreak } from "../hooks/useDailyStreak";
import { useTranslation } from "../hooks/useTranslation";
import { cosmeticEffectClass } from "../lib/profileCosmetics";
import FlameMark from "./FlameMark";
import { StreakProgress } from "./streaks/StreakProgress";

const CARD =
  "rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] p-5 backdrop-blur-xs sm:p-6";

export default function StreakMilestonesCard() {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn, streak, loading, error, load } = useDailyStreak();
  const [unlocks, setUnlocks] = useState<any>(null);
  const [equipBusy, setEquipBusy] = useState<string | null>(null);
  const [equipError, setEquipError] = useState<string | null>(null);

  // The reward ladder + ownership live on the canonical UTC streak endpoint
  // (/api/streaks/me). The hook still supplies the headline numbers, so the
  // card renders immediately and fills the unlock section when it arrives.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    fetch("/api/streaks/me", { cache: "no-store" })
      .then((res) => res.json().catch(() => null))
      .then((json) => {
        if (!cancelled && json?.success) setUnlocks(json);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  const categoryFor = (item: any) =>
    item.kind === "frame" ? "profile_frame" : item.kind;
  const isBoardKind = (kind: string) =>
    kind === "felt" || kind === "card_back" || kind === "deck_skin";
  const defaultFor = (kind: string) =>
    kind === "card_back"
      ? "card_back_default"
      : kind === "deck_skin"
        ? "deck_default"
        : "felt_default";
  const boardSlot = (kind: string) =>
    kind === "card_back" ? "cardBack" : kind === "deck_skin" ? "deckSkin" : "felt";

  const isEquipped = (item: any) => {
    const kind = categoryFor(item);
    if (kind === "title") return unlocks?.selectedSpecialTitle === item.id;
    if (isBoardKind(kind)) return unlocks?.equipped?.[boardSlot(kind)] === item.id;
    return unlocks?.equippedCosmetics?.[kind] === item.id;
  };

  const equip = async (item: any, unequip = false) => {
    setEquipBusy(item.id);
    setEquipError(null);
    const kind = categoryFor(item);
    const endpoint =
      kind === "title" ? "/api/titles/equip-special" : "/api/cosmetics/equip";
    const body =
      kind === "title"
        ? { titleKey: unequip ? null : item.id }
        : isBoardKind(kind)
          ? { item: unequip ? defaultFor(kind) : item.id, category: kind }
          : unequip
            ? { key: null, category: kind }
            : { key: item.id };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || t("rewards.equipError", "Could not equip that reward."));
      }
      setUnlocks((prev: any) => {
        if (!prev) return prev;
        if (kind === "title") {
          return { ...prev, selectedSpecialTitle: unequip ? null : item.id };
        }
        if (isBoardKind(kind)) {
          return {
            ...prev,
            equipped: {
              ...(prev.equipped || {}),
              [boardSlot(kind)]: unequip ? defaultFor(kind) : item.id,
            },
          };
        }
        const equippedCosmetics = { ...(prev.equippedCosmetics || {}) };
        if (unequip) delete equippedCosmetics[kind];
        else equippedCosmetics[kind] = item.id;
        return { ...prev, equippedCosmetics };
      });
    } catch (err: any) {
      setEquipError(err?.message || t("rewards.equipError", "Could not equip that reward."));
    } finally {
      setEquipBusy(null);
    }
  };

  const milestoneTitle = (milestone: any) =>
    milestone?.title
      ? t(`rewards.milestoneTitles.${milestone.days}`, milestone.title)
      : t("rewards.rewardMilestone", "Reward milestone");

  const currentTitleLabel = (() => {
    if (!streak?.title) return t("rewards.newStreak", "New streak");
    const entry = streak.milestones?.find((item: any) => item.title === streak.title);
    return entry ? milestoneTitle(entry) : streak.title;
  })();

  const current = Math.max(0, Number(streak?.current) || 0);
  const best = Math.max(0, Number(streak?.best) || 0);
  const milestones = (
    unlocks?.ladder?.length
      ? unlocks.ladder
      : streak?.rewardMilestones?.length
        ? streak.rewardMilestones
        : streak?.milestones || []
  ).map((milestone: any) => ({
    ...milestone,
    days: milestone.days ?? milestone.day,
    title: milestone.title ?? null,
    items: milestone.items ?? [],
  }));
  const nextFromLadder = milestones.find((milestone: any) => milestone.isNext);
  const next = nextFromLadder
    ? { days: nextFromLadder.days, title: nextFromLadder.title }
    : (streak?.nextMilestone ?? null);

  return (
    <section
      aria-labelledby="streak-milestones-heading"
      data-testid="streak-milestones-card"
      className={CARD}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2
          id="streak-milestones-heading"
          className="flex items-center gap-2 text-xl font-bold text-[color:var(--text-primary)] sm:text-2xl"
        >
          <FlameMark size={26} /> {t("rewards.cardTitle", "Streak Milestones")}
        </h2>
        {streak && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border-strong)] bg-[color:var(--bg-panel)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent-strong)]">
            {t("rewards.cardStreakCount", { count: current })}
          </span>
        )}
      </div>

      {!isLoaded ? (
        <p className="text-sm text-[color:var(--text-muted)]" aria-hidden="true">
          {t("rewards.loading", "Loading your streak…")}
        </p>
      ) : !isSignedIn ? (
        <p className="text-sm text-[color:var(--text-secondary)]">
          <Link
            href="/sign-in"
            className="text-[color:var(--accent-strong)] underline underline-offset-2 hover:text-[color:var(--text-primary)]"
          >
            {t("rewards.signIn", "Sign in")}
          </Link>{" "}
          {t("rewards.signInTail", "to start a streak: finish a game and day one is yours.")}
        </p>
      ) : loading && !streak ? (
        <p className="text-sm text-[color:var(--text-muted)]" aria-hidden="true">
          {t("rewards.loading", "Loading your streak…")}
        </p>
      ) : !streak ? (
        <p className="text-sm text-[color:var(--text-secondary)]">
          {t("rewards.unavailable", "Your streak isn't available right now.")}{" "}
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1 font-semibold text-[color:var(--accent-strong)] underline underline-offset-2 hover:text-[color:var(--text-primary)]"
          >
            <IconRefresh size={13} aria-hidden="true" /> {t("rewards.tryAgain", "Try again")}
          </button>
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                {t("rewards.currentStreak", "Current streak")}
              </p>
              <p className="mt-1 text-2xl font-black text-[color:var(--text-primary)]">
                {current}
                <span className="ml-1 align-middle text-xs font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                  {t(current === 1 ? "rewards.day" : "rewards.days")}
                </span>
              </p>
            </div>
            <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                {t("rewards.bestStreak", "Best streak")}
              </p>
              <p className="mt-1 text-2xl font-black text-[color:var(--text-primary)]">
                {best}
                <span className="ml-1 align-middle text-xs font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                  {t(best === 1 ? "rewards.day" : "rewards.days")}
                </span>
              </p>
            </div>
            <div className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-muted)]">
                {t("rewards.currentTitle", "Current title")}
              </p>
              <p className="mt-1 text-lg font-bold text-[color:var(--accent-strong)]">
                {currentTitleLabel}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-4">
            {next ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                    {t("rewards.nextMilestone", "Next milestone:")}{" "}
                    <span className="text-[color:var(--accent-strong)]">
                      {t("rewards.nextMilestoneValue", {
                        days: next.days,
                        title: milestoneTitle(next),
                      })}
                    </span>
                  </p>
                  <p className="text-sm font-bold text-[color:var(--accent-strong)]">
                    {t("rewards.progressValue", {
                      current: Math.min(current, next.days),
                      target: next.days,
                    })}
                  </p>
                </div>
                <StreakProgress
                  current={current}
                  target={next.days}
                  label={t("rewards.progressAria", {
                    current: Math.min(current, next.days),
                    target: next.days,
                    title: milestoneTitle(next),
                  })}
                  className="mt-2"
                />
                <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
                  {t(
                    streak.daysRemaining === 1
                      ? "rewards.moreDay"
                      : "rewards.moreDays",
                    { count: streak.daysRemaining },
                  )}
                  {streak.shieldAvailable && ` ${t("rewards.shieldReady", "A streak shield is ready to protect one missed day.")}`}
                </p>
              </>
            ) : (
              <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                {t("rewards.allReached", { current, best })}
              </p>
            )}
          </div>

          <h3 className="mt-6 text-[11px] font-black uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
            {t("rewards.allMilestones", "All milestones")}
          </h3>
          <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {milestones.map((milestone) => (
              <li
                key={milestone.days}
                data-testid={`streak-milestone-${milestone.days}`}
                data-state={
                  milestone.achieved ? "achieved" : milestone.isNext ? "next" : "locked"
                }
                className={[
                  "rounded-lg border p-2.5",
                  milestone.achieved
                    ? "border-[color:var(--accent-strong)] bg-[color:var(--bg-panel)]"
                    : milestone.isNext
                      ? "border-[color:var(--accent)] bg-[color:var(--bg-panel)]"
                      : "border-[color:var(--border-hairline)]",
                ].join(" ")}
              >
                <p className="flex items-center justify-between gap-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                  {t("rewards.dayLabel", { day: milestone.days })}
                  {milestone.achieved && (
                    <IconCheck
                      size={12}
                      className="text-[color:var(--accent-strong)]"
                      aria-hidden="true"
                    />
                  )}
                </p>
                <p
                  className={[
                    "mt-0.5 text-sm font-semibold",
                    milestone.achieved || milestone.isNext
                      ? "text-[color:var(--text-primary)]"
                      : "text-[color:var(--text-muted)]",
                  ].join(" ")}
                >
                  {milestoneTitle(milestone)}
                </p>
                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                  {milestone.achieved
                    ? t("rewards.achieved", "Achieved")
                    : milestone.isNext
                      ? t("rewards.next", "Next")
                      : t("rewards.locked", "Locked")}
                </p>
              </li>
            ))}
          </ol>

          {unlocks?.ladder?.length ? (
            <section data-testid="streak-reward-ladder" className="mt-6">
              <h3 className="text-[11px] font-black uppercase tracking-[0.22em] text-[color:var(--text-muted)]">
                {t("rewards.rewardsUnlocks", "Rewards & unlocks")}
              </h3>
              <ul className="mt-3 space-y-2">
                {unlocks.ladder.map((milestone: any) => (
                  <li
                    key={milestone.day}
                    data-testid={`streak-reward-${milestone.day}`}
                    data-state={
                      milestone.achieved ? "achieved" : milestone.isNext ? "next" : "locked"
                    }
                    className="rounded-lg border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                        {t("rewards.dayLabel", { day: milestone.day })}
                        {milestone.title ? ` — ${milestoneTitle({ days: milestone.day, title: milestone.title })}` : ""}
                      </p>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--text-muted)]">
                        {milestone.achieved
                          ? t("rewards.unlocked", "Unlocked")
                          : milestone.isNext
                            ? t("rewards.next", "Next")
                            : t("rewards.locked", "Locked")}
                      </span>
                    </div>
                    {milestone.items.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {milestone.items.map((item: any) => (
                          <li
                            key={item.id}
                            data-testid={`streak-reward-item-${item.id}`}
                            className="flex items-center gap-2 rounded-md border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] px-2 py-1 text-xs text-[color:var(--text-secondary)]"
                          >
                            {item.kind === "profile_glow" && (
                              <span
                                aria-hidden="true"
                                data-testid={`streak-reward-preview-${item.id}`}
                                className={`inline-block h-5 w-8 shrink-0 rounded-md border border-white/20 ${cosmeticEffectClass(item.visual) || ""}`}
                              />
                            )}
                            {item.kind === "username_effect" && (
                              <span
                                aria-hidden="true"
                                data-testid={`streak-reward-preview-${item.id}`}
                                className={`shrink-0 text-[11px] font-black ${cosmeticEffectClass(item.visual) || ""}`}
                              >
                                Aa
                              </span>
                            )}
                            <span>
                              {t(
                                `profile.streakRewards.${item.id}.name`,
                                item.label,
                              )}
                            </span>
                            {item.owned ? (
                              <>
                                {isEquipped(item) && (
                                  <span className="rounded-sm border border-[color:var(--accent-strong)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--accent-strong)]">
                                    {t("rewards.equipped", "Equipped")}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  data-testid={`streak-reward-action-${item.id}`}
                                  onClick={() => equip(item, isEquipped(item))}
                                  disabled={equipBusy === item.id}
                                  aria-label={
                                    isEquipped(item)
                                      ? t("rewards.unequipItem", { name: item.label })
                                      : t("rewards.equipItem", { name: item.label })
                                  }
                                  className="rounded-sm bg-[color:var(--accent)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--bg-surface)] disabled:opacity-50"
                                >
                                  {equipBusy === item.id
                                    ? t("rewards.equipping", "Equipping…")
                                    : isEquipped(item)
                                      ? t("rewards.unequip", "Unequip")
                                      : t("rewards.equip", "Equip")}
                                </button>
                              </>
                            ) : (
                              <span className="text-[10px] uppercase tracking-wider text-[color:var(--text-muted)]">
                                {t("rewards.dayLabel", { day: milestone.day })}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
              {equipError && (
                <p role="alert" className="mt-2 text-xs text-[color:var(--text-secondary)]">
                  {equipError}
                </p>
              )}
            </section>
          ) : null}

          <p className="mt-4 text-xs leading-relaxed text-[color:var(--text-muted)]">
            {t("rewards.cardNote", "Finish a game to advance one day. Several games on the same day count once, and missing a day starts the current streak again at day 1 — your best streak and earned titles stay.")}
          </p>
        </>
      )}

      {error && streak && (
        <p className="mt-3 text-sm text-[color:var(--text-secondary)]" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
