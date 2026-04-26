"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import NavigationBar from "../../../components/navigation-bar";

const rarityStyles = {
  Common: "border-white/20 text-slate-100",
  Bronze: "border-amber-600/70 text-amber-300",
  Silver: "border-slate-300/70 text-slate-200",
  Gold: "border-yellow-400/80 text-yellow-300 shadow-[0_0_20px_rgba(250,204,21,0.25)]",
  Elite: "border-cyan-400/80 text-cyan-200 shadow-[0_0_20px_rgba(34,211,238,0.30)]",
  Mythic: "border-fuchsia-400/80 text-fuchsia-200 shadow-[0_0_24px_rgba(217,70,239,0.30)]",
  Overlord: "border-rose-400/80 text-rose-200 shadow-[0_0_26px_rgba(251,113,133,0.35)]",
};

const rareTiers = new Set(["Elite", "Mythic", "Overlord"]);

export default function TitlesPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [titlesData, setTitlesData] = useState(null);
  const [toast, setToast] = useState("");
  const [confetti, setConfetti] = useState(false);

  const unlockedSet = useMemo(
    () => new Set((titlesData?.unlockedTitles || []).map((title) => title.title)),
    [titlesData]
  );

  const loadTitles = async () => {
    const [syncRes, titlesRes] = await Promise.all([
      fetch("/api/titles/sync", { method: "POST", credentials: "include" }),
      fetch("/api/titles", { credentials: "include" }),
    ]);

    const syncData = await syncRes.json();
    const nextData = await titlesRes.json();

    if (!titlesRes.ok || !nextData.success) {
      throw new Error(nextData.error || "Failed to load titles");
    }

    if (syncData?.newUnlockedTitle) {
      setToast(`NEW TITLE UNLOCKED: ${syncData.newUnlockedTitle}`);
      const unlocked = nextData.unlockedTitles.find((item) => item.title === syncData.newUnlockedTitle);
      if (unlocked && rareTiers.has(unlocked.rarity)) {
        setConfetti(true);
        setTimeout(() => setConfetti(false), 1800);
      }
    }

    setTitlesData(nextData);
  };

  useEffect(() => {
    (async () => {
      try {
        await loadTitles();
      } catch (error) {
        setToast(error.message || "Failed to load titles.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(timeout);
  }, [toast]);

  const handleSelect = async (title) => {
    if (!titlesData || !unlockedSet.has(title)) return;

    try {
      setSaving(true);
      const response = await fetch("/api/titles/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to equip title");

      setTitlesData((prev) => ({ ...prev, selectedTitle: title }));
      setToast(`Equipped: ${title}`);
      window.dispatchEvent(new Event("titleUpdated"));
      window.dispatchEvent(new Event("profileUpdated"));
    } catch (error) {
      setToast(error.message || "Could not equip title.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#122044_0%,#020617_45%,#000_100%)] text-white">
      <NavigationBar currentPath="/profile/titles" />
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-24">
        <h1 className="mb-6 text-center text-4xl font-extrabold text-transparent bg-gradient-to-r from-[#00e5ff] via-[#f5ff3b] to-[#f472b6] bg-clip-text">Title Vault</h1>

        {toast && <div className="fixed right-4 top-20 z-50 rounded-lg border border-[#00e5ff]/40 bg-[#061331]/90 px-4 py-3 text-sm shadow-[0_0_20px_rgba(0,229,255,0.35)]">{toast}</div>}

        {confetti && (
          <div className="confetti-overlay">
            {Array.from({ length: 45 }).map((_, index) => (
              <span key={`title-confetti-${index}`} className="confetti-piece" style={{ left: `${(index / 45) * 100}%`, animationDelay: `${(index % 9) * 0.06}s` }} />
            ))}
          </div>
        )}

        {loading ? (
          <p className="text-center text-cyan-100/80">Loading titles...</p>
        ) : (
          <>
            <section className="mb-8 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-md">
                <p className="text-xs text-slate-300">Equipped Title</p>
                <p className="mt-2 text-xl font-bold text-[#f5ff3b]">{titlesData?.selectedTitle || "None equipped"}</p>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-md">
                <p className="text-xs text-slate-300">Highest Unlocked</p>
                <p className="mt-2 text-xl font-bold text-cyan-200">{titlesData?.highestTitle || "Rookie"}</p>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/5 p-4 backdrop-blur-md">
                <p className="text-xs text-slate-300">Next Title</p>
                <p className="mt-2 text-lg font-bold text-rose-200">{titlesData?.nextTitle ? `${titlesData.nextTitle.title} (Lv ${titlesData.nextTitle.level})` : "Maxed"}</p>
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(titlesData?.allTitles || []).map((titleMeta) => {
                const unlocked = unlockedSet.has(titleMeta.title);
                const equipped = titlesData?.selectedTitle === titleMeta.title;

                return (
                  <motion.button
                    key={titleMeta.title}
                    whileHover={{ scale: unlocked ? 1.03 : 1 }}
                    whileTap={{ scale: unlocked ? 0.98 : 1 }}
                    onClick={() => handleSelect(titleMeta.title)}
                    disabled={!unlocked || saving}
                    title={unlocked ? `Unlocked at Level ${titleMeta.level}` : `Unlock at Level ${titleMeta.level}`}
                    className={[
                      "rounded-2xl border bg-white/5 p-4 text-left backdrop-blur-md transition",
                      rarityStyles[titleMeta.rarity] || rarityStyles.Common,
                      !unlocked ? "cursor-not-allowed grayscale opacity-45" : "hover:bg-white/10",
                      equipped ? "ring-2 ring-[#f5ff3b]" : "",
                    ].join(" ")}
                  >
                    <p className="text-xs uppercase tracking-widest text-slate-300">{titleMeta.rarity}</p>
                    <h3 className="mt-1 text-xl font-bold">{titleMeta.title}</h3>
                    <p className="mt-2 text-xs text-slate-300">Unlocks at level {titleMeta.level}</p>
                    {equipped && <p className="mt-2 text-xs font-semibold text-[#f5ff3b]">Equipped</p>}
                  </motion.button>
                );
              })}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
