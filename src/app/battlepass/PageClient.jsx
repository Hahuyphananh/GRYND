"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";
import { useTranslation } from "../../hooks/useTranslation";
import {
  REWARD_RARITIES,
  REWARD_TYPES,
} from "../../lib/battlepassRewards";

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

export default function BattlepassPageClient() {
  const { t } = useTranslation();
  const [pass, setPass] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
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
    };
    load();
  }, []);

  const level = pass?.level ?? 1;
  const progressPercent = pass?.progressPercent ?? 0;
  const isMaxed = level >= (pass?.maxLevel ?? 100);

  return (
    <div className="min-h-screen bg-[#050b1e] text-white">
      <InteractiveCasinoBg />
      <NavigationBar />

      <main className="relative z-10 mx-auto max-w-3xl px-4 pb-20 pt-28">
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
            {/* Current status */}
            <div className="rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6 shadow-[0_0_24px_rgba(0,229,255,0.15)]">
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
                    <div className="font-medium text-white">Wager tokens</div>
                    <div className="mt-0.5 text-sm text-[#9dd8ff]">
                      Earn 1 XP per 10 tokens wagered on any game. The bigger
                      the bet, the faster you level up.
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

            {/* Level track */}
            <div className="mt-6 rounded-xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-6">
              <h2 className="text-lg font-semibold text-[#00e5ff]">
                Level track & rewards
              </h2>
              <p className="mt-1 text-xs text-[#7dd3fc]">
                Each level needs more XP than the last — 150 XP to reach level
                2, growing by 10 XP per level. Rewards get rarer as you
                climb.
              </p>
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
                  Icons & cosmetics (soon)
                </span>
              </div>
              <div className="mt-5 space-y-1.5">
                {pass.levels.map((lvl) => {
                  const unlocked = lvl.level <= level;
                  const isCurrent = lvl.level === level;
                  return (
                    <div
                      key={lvl.level}
                      className={`flex items-center gap-3 rounded-lg border p-2.5 ${
                        isCurrent
                          ? "border-[#f5ff3b]/60 bg-[#f5ff3b]/10 shadow-[0_0_14px_rgba(245,255,59,0.15)]"
                          : unlocked
                            ? "border-[#00e5ff]/20 bg-[#00e5ff]/5"
                            : "border-white/5 bg-transparent opacity-60"
                      }`}
                    >
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-bold ${
                          isCurrent
                            ? "border-[#f5ff3b] bg-[#f5ff3b] text-[#050b1e]"
                            : unlocked
                              ? "border-[#00e5ff]/60 bg-[#00e5ff]/15 text-[#00e5ff]"
                              : "border-white/15 bg-white/5 text-[#9dd8ff]"
                        }`}
                      >
                        {lvl.level}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span
                            className={`text-sm font-medium ${unlocked ? "text-white" : "text-[#9dd8ff]"}`}
                          >
                            {unlocked && !isCurrent
                              ? "Unlocked"
                              : isCurrent
                                ? "Current level"
                                : `Level ${lvl.level}`}
                          </span>
                          {lvl.title && (
                            <span
                              className="text-xs font-semibold"
                              style={{
                                color:
                                  RARITY_COLORS[lvl.title.rarity] ||
                                  "#f5c542",
                              }}
                            >
                              ★ Unlocks title: {lvl.title.title}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-[#7dd3fc]">
                          <span>
                            Reach {formatNumber(lvl.xpRequired)} XP
                            {lvl.level > 1 &&
                              lvl.level < pass.maxLevel &&
                              ` · ${formatNumber(lvl.xpForNext)} XP for the next`}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        {lvl.rewards?.length > 0 ? (
                          <div className="flex flex-col items-end gap-1">
                            {lvl.rewards.map((reward, i) => (
                              <div
                                key={i}
                                className="flex items-center gap-1.5"
                              >
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
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
                                <div className="text-right">
                                  <div
                                    className="text-xs font-semibold"
                                    style={{ color: rewardColor(reward) }}
                                  >
                                    {reward.name}
                                  </div>
                                  <div className="text-[10px] text-[#7dd3fc]">
                                    {reward.desc}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wider text-[#9dd8ff]">
                            Icons & cosmetics soon
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
