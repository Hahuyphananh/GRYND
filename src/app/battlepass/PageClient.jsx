"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { useTranslation } from "../../hooks/useTranslation";
import {
  REWARD_RARITIES,
  REWARD_TYPES,
} from "../../lib/battlepassRewards";
import { emoteAssetUrl } from "../../lib/emoteAssets";

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

const RARITY_COLORS = REWARD_RARITIES;

function rewardColor(reward) {
  return (
    REWARD_RARITIES[reward.rarity] ||
    REWARD_TYPES[reward.type]?.color ||
    "#9ca3af"
  );
}

// Reward types the player explicitly claims (vs. pure display entries).
// Functional types claim by track level; cosmetic types claim by catalog key.
const CLAIMABLE_UI_TYPES = new Set([
  "emote",
  "title",
  "color",
  "xp_boost",
  "quest_boost",
  "shield",
  "tokens",
  "battlepass_xp",
  "quest_reroll",
  "badge",
  "profile_frame",
  "avatar_effect",
  "username_effect",
  "chat_effect",
  "profile_glow",
  "prestige_effect",
  "cosmetic",
]);

export default function BattlepassPageClient() {
  const { t } = useTranslation();
  const [pass, setPass] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [failedEmoteRewards, setFailedEmoteRewards] = useState({});
  // Prestige tier that just unlocked and is being celebrated (null = none).
  const [prestigeCelebrated, setPrestigeCelebrated] = useState(null);
  // Per-reward claim state — rewards are NEVER auto-granted; the player
  // clicks "Claim" on each reached emote reward.
  const [claimingKey, setClaimingKey] = useState(null);
  const [claimError, setClaimError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/battlepass");
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok || !data.success) {
        setError(data.error || "Could not load the battlepass.");
      } else {
        setPass(data.pass);
      }
    } catch {
      setError("Could not load the battlepass.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const claimReward = async (reward, level) => {
    if (claimingKey) return;
    // Functional rewards (xp_boost / quest_boost / shield / tokens /
    // battlepass_xp / quest_reroll / grynd) have no key — they're
    // disambiguated by their track level, so include it in the claim payload
    // so each identical entry is claimed exactly once.
    const isFunctional =
      reward.type === "xp_boost" ||
      reward.type === "quest_boost" ||
      reward.type === "shield" ||
      reward.type === "grynd" ||
      reward.type === "tokens" ||
      reward.type === "battlepass_xp" ||
      reward.type === "quest_reroll";
    const key = `${reward.type}:${reward.key ?? `lvl${level}`}`;
    setClaimingKey(key);
    setClaimError(null);
    try {
      const res = await fetch("/api/battlepass/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: reward.type,
          key: reward.key,
          level: isFunctional ? level : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setClaimError(data.error || "Could not claim this reward.");
        return;
      }
      // Grynd+ Days rewards hand back a Stripe checkout URL (free trial) —
      // mirror the claimed state locally, then send the player to Stripe.
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      // Update the pass IN PLACE so the claimed reward flips to "Unlocked"
      // without a full re-fetch (which replaces the track with the loading
      // spinner and re-centers the scroll, forcing the user to scroll back
      // after every claim). The server response is authoritative — we only
      // mirror the claimed state locally. Already-claimed responses are a
      // no-op (double-click guard).
      if (!data.alreadyClaimed) {
        setPass((prev) => {
          if (!prev) return prev;
          const matches = (r) =>
            r.type === reward.type &&
            (isFunctional || r.key === reward.key);
          const wasClaimable = prev.levels.some(
            (entry) => entry.level === level &&
              entry.rewards.some((r) => matches(r) && r.claimable),
          );
          const levels = prev.levels.map((entry) =>
            entry.level !== level
              ? entry
              : {
                  ...entry,
                  rewards: entry.rewards.map((r) =>
                    matches(r) ? { ...r, claimed: true, claimable: false } : r,
                  ),
                },
          );
          return {
            ...prev,
            levels,
            unclaimedCount: wasClaimable
              ? Math.max(0, (prev.unclaimedCount || 0) - 1)
              : prev.unclaimedCount,
          };
        });
      }
    } catch {
      setClaimError("Could not claim this reward.");
    } finally {
      setClaimingKey(null);
    }
  };

  // Horizontal battlepass track — refs + auto-centering on the current level.
  const trackRef = useRef(null);
  const currentCellRef = useRef(null);

  const scrollTrack = (delta) => {
    trackRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  };

  // Horizontal battlepass track — auto-center on the CURRENT LEVEL only
  // (not on every pass update). Depends on pass?.level, so claiming rewards
  // in place (setPass below) never re-centers the track and the user keeps
  // their scroll position while claiming in one go.
  useEffect(() => {
    if (!pass) return;
    const track = trackRef.current;
    const cell = currentCellRef.current;
    if (!track || !cell) return;
    // Wait a tick for layout, then center the player's current level.
    const id = setTimeout(() => {
      track.scrollTo({
        left: cell.offsetLeft - (track.clientWidth - cell.offsetWidth) / 2,
        behavior: "smooth",
      });
    }, 80);
    return () => clearTimeout(id);
  }, [pass?.level]);

  // Prestige-advancement celebration. The tier number always comes from the
  // server response (/api/battlepass) — the client can never fabricate it.
  // A localStorage watermark suppresses the modal until the prestige level
  // actually increases: first visits only seed the watermark, so the modal
  // never pops merely because the page loaded.
  useEffect(() => {
    if (!pass) return;
    const level = Math.max(0, Number(pass.prestige) || 0);
    const unlocked = Boolean(pass.prestigeUnlocked);
    const STORAGE_KEY = "grynd.prestige.celebrated.v1";
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const seen = raw ? Math.max(0, Number(JSON.parse(raw)) || 0) : 0;
      if (unlocked && level >= 1 && level > seen) {
        setPrestigeCelebrated(level);
      }
      // Persist every observed level so a later higher tier triggers the
      // modal exactly once per advancement.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(level));
    } catch {
      // Storage unavailable — skip the celebration; never crash the page.
    }
  }, [pass]);

  const level = pass?.level ?? 1;
  const progressPercent = pass?.progressPercent ?? 0;
  const isMaxed = level >= (pass?.maxLevel ?? 100);

  return (
    <div className="min-h-screen bg-[#050b1e] text-white">
      <InteractiveCasinoBg />
      <NavigationBar />

      <main className="relative z-10 mx-auto max-w-5xl px-4 pb-20 pt-28">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#00e5ff]/40 bg-[#0b224f]/85 shadow-[0_0_24px_rgba(0,229,255,0.25)]">
            <svg
              className="h-9 w-9 text-[#00e5ff]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6.4-4.8-6.4 4.8 2.4-7.2-6-4.8h7.6z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-[#f5ff3b] drop-shadow-[0_0_12px_rgba(245,255,59,0.4)]">
            Battlepass
          </h1>
          <p className="mt-2 text-sm text-[#9dd8ff]">
            Earn XP by wagering tokens and completing quests to climb 100
            levels and unlock rewards — from name glows and titles to XP
            boosts and Grynd+ days.
          </p>
        </div>

        {loading ? (
          <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-10 text-center text-[#9dd8ff]">
            {t("ui.loading")}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-400/30 bg-[#0b224f]/85 p-10 text-center text-red-300">
            {error}
          </div>
        ) : (
          <>
            {/* Current status — Level-100 players see the permanent Prestige track */}
            {pass.prestigeUnlocked ? (
              <div className="rounded-xl border border-violet-400/40 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(139,92,246,0.25)]">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.2em]">
                      <span className="rounded-full border border-[#f5ff3b]/60 bg-[#f5ff3b]/15 px-2.5 py-0.5 tracking-[0.2em] text-[#f5ff3b]">
                        Level 100
                      </span>
                      <span className="rounded-full border border-violet-400/60 bg-violet-500/15 px-2.5 py-0.5 tracking-[0.2em] text-violet-300">
                        Prestige unlocked
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-baseline gap-2">
                      <span className="text-4xl font-bold text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)]">
                        Prestige {pass.prestige}
                      </span>
                      {pass.prestige >= pass.maxPrestige && (
                        <span className="rounded-full border border-violet-400/70 bg-violet-500/20 px-2.5 py-0.5 text-xs font-bold text-violet-200">
                          Max Prestige
                        </span>
                      )}
                    </div>
                    {pass.prestige < pass.maxPrestige ? (
                      <div className="mt-1 text-sm text-[#9dd8ff]">
                        {formatNumber(pass.prestigeNetWins)} /{" "}
                        {formatNumber(pass.nextPrestigeRequirement)} Net Wins
                        toward Prestige {pass.prestige + 1}
                      </div>
                    ) : (
                      <div className="mt-1 text-sm text-[#9dd8ff]">
                        {formatNumber(pass.prestigeNetWins)} Net Wins — every
                        tier cleared
                      </div>
                    )}
                  </div>
                  <div className="rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-4 py-1.5 text-sm font-semibold text-[#f5ff3b]">
                    {formatNumber(pass.xp)} XP total
                  </div>
                </div>

                <div className="mt-5 h-3 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-gradient-to-r from-violet-500 via-fuchsia-500 to-[#00e5ff] transition-all duration-500"
                    style={{ width: `${pass.prestigeProgressPercent}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-sm text-gray-300">
                  <span>
                    {pass.prestige < pass.maxPrestige
                      ? `${formatNumber(Math.max(0, pass.nextPrestigeRequirement - pass.prestigeNetWins))} Net Wins to Prestige ${pass.prestige + 1}`
                      : "Maximum Prestige reached"}
                  </span>
                  <span>
                    {pass.prestige < pass.maxPrestige
                      ? `${pass.prestigeProgressPercent}%`
                      : "100%"}
                  </span>
                </div>
                <div className="mt-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-xs leading-relaxed text-[#7dd3fc]">
                  Level 100 is permanent — there is no seasonal reset and
                  Prestige never rolls back. A loss lowers your current
                  Net-Win progress but can never remove an earned Prestige.
                  Your existing rewards, titles, and cosmetics stay yours.
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
                {pass.unclaimedCount > 0 && (
                  <div className="mb-4 flex items-center justify-between gap-2 rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-3 py-2">
                    <span className="text-sm font-semibold text-[#f5ff3b]">
                      🎁 {pass.unclaimedCount} reward
                      {pass.unclaimedCount === 1 ? "" : "s"} ready to claim
                    </span>
                  </div>
                )}
                {claimError && (
                  <p className="mb-3 text-xs font-medium text-red-300">
                    {claimError}
                  </p>
                )}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-[#7dd3fc]">
                      Current level
                    </div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-4xl font-bold text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)]">
                        {level}
                      </span>
                      <span className="text-sm text-[#7dd3fc]">
                        / {pass.maxLevel}
                      </span>
                    </div>
                  </div>
                  <div className="rounded-full border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 px-4 py-1.5 text-sm font-semibold text-[#f5ff3b]">
                    {formatNumber(pass.xp)} XP total
                  </div>
                </div>

                <div className="mt-5 h-3 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-gradient-to-r from-yellow-400 via-orange-400 to-pink-500 transition-all duration-500"
                    style={{ width: `${isMaxed ? 100 : progressPercent}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-sm text-gray-300">
                  <span>
                    {isMaxed
                      ? "Max level reached!"
                      : `${formatNumber(pass.xp - pass.currentLevelXp)} / ${formatNumber(pass.nextLevelXp - pass.currentLevelXp)} XP to level ${level + 1}`}
                  </span>
                  <span>{isMaxed ? "100%" : `${progressPercent}%`}</span>
                </div>
                {!isMaxed && (
                  <div className="mt-1 text-xs text-[#7dd3fc]">
                    {formatNumber(pass.remainingToNext)} XP remaining to level{" "}
                    {level + 1} · Reach {formatNumber(pass.nextLevelRequired)}{" "}
                    XP total
                  </div>
                )}
              </div>
            )}

            {/* How to earn XP */}
            <div className="mt-6 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6">
              <h2 className="text-lg font-semibold text-[#00e5ff]">
                How to earn XP
              </h2>
              <div className="mt-4 space-y-4">
                <div className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#f5ff3b]/40 bg-[#f5ff3b]/10 text-lg">
                    🎲
                  </div>
                  <div>
                    <div className="font-medium text-white">Stake tokens</div>
                    <div className="mt-0.5 text-sm text-[#9dd8ff]">
                      Earn 1 XP per 10 tokens staked on any game. The bigger
                      the stake, the faster you level up.
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-lg">
                    🎯
                  </div>
                  <div>
                    <div className="font-medium text-white">Complete quests</div>
                    <div className="mt-0.5 text-sm text-[#9dd8ff]">
                      Claiming daily and weekly quests grants bonus XP on top
                      of their token rewards.
                    </div>
                  </div>
                </div>
              </div>
              <Link
                href="/"
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-[#f5ff3b] hover:text-yellow-300"
              >
                Open today's quests on the home page →
              </Link>
            </div>

            {/* Premium upsell — shown to non-members while premium rewards
                exist on the track. Members see the standard header. */}
            {pass.isPremium === false && (
              <div className="mt-6 rounded-xl border border-[#a78bfa]/40 bg-[#0b224f]/85 p-5 shadow-[0_0_24px_rgba(139,92,246,0.15)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#a78bfa]/50 bg-[#a78bfa]/15 text-lg">
                      👑
                    </div>
                    <div>
                      <div className="text-sm font-bold text-[#a78bfa]">
                        Unlock premium rewards with Grynd+
                      </div>
                      <div className="mt-0.5 text-xs text-[#9dd8ff]/70">
                        The 4 rare animated emotes on this track are exclusive to
                        members. Already claimed one? It stays yours forever.
                      </div>
                    </div>
                  </div>
                  <Link
                    href="/shop"
                    className="rounded-xl bg-[#a78bfa] px-4 py-2 text-sm font-bold text-[#050b1e] transition hover:bg-[#c4b5fd]"
                  >
                    Get Grynd+ →
                  </Link>
                </div>
              </div>
            )}

            {/* Level track — horizontal battlepass, Brawl-Stars style */}
            <div className="mt-6 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-5 sm:p-6">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-[#00e5ff]">
                    Level track & rewards
                  </h2>
                  <p className="mt-1 text-xs text-[#7dd3fc]">
                    Rewards sit on a horizontal track — scroll sideways through
                    all {pass.maxLevel} levels. Each level needs more XP than
                    the last, and rewards get rarer as you climb.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => scrollTrack(-420)}
                    aria-label="Scroll track left"
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-xl leading-none text-[#00e5ff] transition hover:bg-[#00e5ff]/25"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => scrollTrack(420)}
                    aria-label="Scroll track right"
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-xl leading-none text-[#00e5ff] transition hover:bg-[#00e5ff]/25"
                  >
                    ›
                  </button>
                </div>
              </div>

              {/* Legend */}
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 border-b border-white/10 pb-4">
                {Object.entries(REWARD_TYPES).map(([key, meta]) => (
                  <span
                    key={key}
                    className="flex items-center gap-1.5 text-[11px] text-[#9dd8ff]"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: meta.color }}
                    />
                    {meta.label}
                  </span>
                ))}
                <span className="flex items-center gap-1.5 text-[11px] text-[#9dd8ff]">
                  <span className="h-2 w-2 rounded-full bg-white/40" />
                  Official cosmetics
                </span>
              </div>

              {/* ── The battlepass div: one horizontal, scrollable track ── */}
              <div className="relative mt-5">
                {/* path line through the level badges */}
                <div className="pointer-events-none absolute left-0 right-0 top-[34px] h-0.5 bg-gradient-to-r from-transparent via-[#00e5ff]/35 to-transparent" />
                <div
                  ref={trackRef}
                  className="flex snap-x gap-2 overflow-x-auto pb-3 pt-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-white/5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#00e5ff]/40"
                >
                  {pass.levels.map((lvl) => {
                    const unlocked = lvl.level <= level;
                    const isCurrent = lvl.level === level;
                    return (
                      <div
                        key={lvl.level}
                        ref={isCurrent ? currentCellRef : undefined}
                        className={`relative flex w-[150px] shrink-0 snap-start flex-col items-center rounded-xl border p-2.5 text-center transition ${
                          isCurrent
                            ? "border-[#f5ff3b]/70 bg-[#f5ff3b]/10 shadow-[0_0_18px_rgba(245,255,59,0.2)]"
                            : unlocked
                              ? "border-[#00e5ff]/25 bg-[#00e5ff]/5"
                              : "border-white/5 bg-white/[0.03] opacity-60"
                        }`}
                      >
                        {/* Level badge */}
                        <div
                          className={`relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-bold ${
                            isCurrent
                              ? "border-[#f5ff3b] bg-[#f5ff3b] text-[#050b1e] shadow-[0_0_14px_rgba(245,255,59,0.5)]"
                              : unlocked
                                ? "border-[#00e5ff]/60 bg-[#00e5ff]/15 text-[#00e5ff]"
                                : "border-white/15 bg-white/5 text-[#9dd8ff]"
                          }`}
                        >
                          {lvl.level}
                        </div>
                        {/* Current-level marker */}
                        {isCurrent && (
                          <span className="absolute left-1/2 top-0 z-20 -translate-x-1/2 rounded-full border border-[#f5ff3b]/70 bg-[#050b1e] px-1.5 py-px text-[9px] font-black tracking-wider text-[#f5ff3b] shadow-[0_0_10px_rgba(245,255,59,0.4)]">
                            YOU
                          </span>
                        )}

                        {/* Rewards */}
                        <div className="mt-2 flex w-full flex-col gap-1.5">
                          {lvl.rewards?.length > 0 ? (
                            lvl.rewards.map((reward, i) => (
                              <div key={i}>
                                <div className="flex items-center justify-center gap-1">
                                  <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{
                                      background:
                                        reward.type === "color" && reward.value
                                          ? reward.value
                                          : rewardColor(reward),
                                      boxShadow: `0 0 6px ${
                                        reward.type === "color" && reward.value
                                          ? reward.value
                                          : rewardColor(reward)
                                      }`,
                                    }}
                                  />
                                  <span
                                    className="text-[11px] font-semibold leading-tight"
                                    style={{ color: rewardColor(reward) }}
                                  >
                                    {reward.name}
                                  </span>
                                </div>
                                {reward.type === "emote" && (
                                  <div className="mt-1 flex h-12 items-center justify-center overflow-hidden rounded border border-white/10 bg-[#08142f]">
                                    {emoteAssetUrl(reward.key) && !failedEmoteRewards[reward.key] ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={emoteAssetUrl(reward.key)}
                                        alt=""
                                        className="h-10 w-10 object-contain"
                                        loading="lazy"
                                        onError={() =>
                                          setFailedEmoteRewards((previous) => ({
                                            ...previous,
                                            [reward.key]: true,
                                          }))
                                        }
                                      />
                                    ) : (
                                      <span className="text-[8px] text-white/40">Artwork coming soon</span>
                                    )}
                                  </div>
                                )}
                                <div className="text-[9px] leading-tight text-[#7dd3fc]">
                                  {reward.desc}
                                </div>
                                {/* Premium-track badge + lock — non-members
                                    see premium rewards locked with a
                                    subscribe CTA (unless already owned:
                                    grandfathered owners keep their
                                    rewards). */}
                                {reward.premium && reward.locked && (
                                  <div className="mt-1 rounded-md border border-[#a78bfa]/50 bg-[#a78bfa]/10 px-1.5 py-1">
                                    <div className="flex items-center justify-center gap-1 text-[9px] font-bold text-[#a78bfa]">
                                      <span aria-hidden>🔒</span> Grynd+ Premium
                                    </div>
                                    <Link
                                      href="/shop"
                                      className="mt-1 block w-full rounded-md bg-[#a78bfa] px-2 py-1 text-center text-[9px] font-bold text-[#050b1e] transition hover:bg-[#c4b5fd]"
                                    >
                                      Subscribe
                                    </Link>
                                  </div>
                                )}
                                {reward.premium && !reward.locked && !reward.claimed && (
                                  <div className="mt-1 rounded-md border border-[#a78bfa]/40 bg-[#a78bfa]/5 px-1.5 py-0.5 text-center text-[9px] font-bold text-[#a78bfa]">
                                    ✦ Grynd+ Premium
                                  </div>
                                )}
                                {CLAIMABLE_UI_TYPES.has(reward.type) &&
                                  reward.claimed && (
                                    <div className="text-[9px] font-semibold text-emerald-300">
                                      Unlocked
                                    </div>
                                  )}
                                {CLAIMABLE_UI_TYPES.has(reward.type) &&
                                  reward.claimable && (
                                    <button
                                      type="button"
                                      onClick={() => claimReward(reward, lvl.level)}
                                      disabled={
                                        claimingKey ===
                                        `${reward.type}:${reward.key ?? `lvl${lvl.level}`}`
                                      }
                                      className="mt-1 w-full rounded-md border border-[#f5ff3b]/60 bg-[#f5ff3b]/15 px-2 py-1 text-[10px] font-bold text-[#f5ff3b] transition hover:bg-[#f5ff3b]/30 disabled:opacity-50"
                                    >
                                      {claimingKey ===
                                      `${reward.type}:${reward.key ?? `lvl${lvl.level}`}`
                                        ? "Claiming…"
                                        : "Claim"}
                                    </button>
                                  )}
                              </div>
                            ))
                          ) : (
                            <span className="mx-auto rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] uppercase leading-snug tracking-wider text-[#9dd8ff]">
                              Official<br />cosmetics
                            </span>
                          )}
                        </div>

                        {/* Title unlock */}
                        {lvl.title && (
                          <div className="mt-1.5 w-full border-t border-white/10 pt-1">
                            <span
                              className="text-[9px] font-semibold leading-tight"
                              style={{
                                color:
                                  RARITY_COLORS[lvl.title.rarity] || "#f5c542",
                              }}
                            >
                              ★ {lvl.title.title}
                            </span>
                          </div>
                        )}

                        {/* XP requirement */}
                        <div className="mt-1.5 text-[9px] text-[#7dd3fc]/70">
                          Reach {formatNumber(lvl.xpRequired)} XP
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Prestige-advancement celebration — fires only when the server-
          reported tier increased since the last visit (see watermark above). */}
      {prestigeCelebrated !== null && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Prestige ${prestigeCelebrated} unlocked`}
        >
          <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-violet-400/50 bg-[#0b224f] p-8 text-center shadow-[0_0_60px_rgba(139,92,246,0.45)]">
            <div className="pointer-events-none absolute -top-10 left-1/2 h-32 w-32 -translate-x-1/2 rounded-full bg-violet-500/25 blur-2xl" />
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-300/60 bg-violet-500/20 text-2xl shadow-[0_0_18px_rgba(139,92,246,0.5)]">
              👑
            </div>
            <div className="text-xs uppercase tracking-[0.35em] text-violet-300">
              Prestige
            </div>
            <div className="mt-1 text-6xl font-black text-[#f5ff3b] drop-shadow-[0_0_18px_rgba(245,255,59,0.6)]">
              {prestigeCelebrated}
            </div>
            <div className="mt-1 text-lg font-bold tracking-[0.3em] text-white">
              UNLOCKED
            </div>
            <p className="mt-3 text-sm leading-relaxed text-[#9dd8ff]">
              You reached a new permanent Prestige tier. Keep competing to
              climb further — Prestige never resets and an earned tier can
              never be lost.
            </p>
            <button
              type="button"
              onClick={() => setPrestigeCelebrated(null)}
              className="mt-5 w-full rounded-xl border border-[#00e5ff]/50 bg-[#00e5ff]/15 px-4 py-2.5 font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              Claim it
            </button>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
