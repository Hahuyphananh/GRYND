import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";

import { LanguageProvider } from "../src/context/LanguageContext";
import RewardsPage from "../src/app/rewards/PageClient";
import LeaderboardPage from "../src/app/classement/PageClient";
import ChooseFrameModal from "../src/components/ChooseFrameModal";
import { cosmeticEffectClass, cosmeticFrameRing } from "../src/lib/profileCosmetics";
import { STREAK_MILESTONES } from "../src/lib/streaks/schedule";
import { boardItem, profileStreakItem } from "../src/lib/solitaire-duel/boardCosmetics";
import { getStreakMilestoneState } from "../src/lib/streakTitles";

const params = new URLSearchParams(window.location.search);
const SCREEN = params.get("screen") || "rewards";
const CURRENT = Math.max(0, Number(params.get("current") || 100) || 0);
const SCENARIO = params.get("scenario") || "normal";
const SIGNED_IN = window.__PHASE12_SIGNED_IN !== false;

const EQUIPMENT_KEY = "phase12_equipment";
const DEFAULT_EQUIPMENT = {};

const VISUALS = {
  felt_slate: { cssClass: "felt-slate" },
  felt_royal_emerald: { cssClass: "felt-royal-emerald" },
  felt_midnight_navy: { cssClass: "felt-midnight-navy" },
  felt_crimson_velvet: { cssClass: "felt-crimson-velvet" },
  felt_eternal_obsidian: { cssClass: "felt-eternal-obsidian" },
  card_back_carbon: { cssClass: "card-back-carbon" },
  card_back_emerald_gold: { cssClass: "card-back-emerald-gold" },
  card_back_centurion: { cssClass: "card-back-centurion" },
  card_back_crimson_monogram: { cssClass: "card-back-crimson-monogram" },
  card_back_eternal: { cssClass: "card-back-eternal" },
  deck_grandmaster: { cssClass: "deck-grandmaster" },
  badge_flame_14: { color: "#f59e0b" },
  badge_flame_blue: { color: "#38bdf8" },
  badge_365_plus: { color: "#c9a24a" },
  frame_eternal: { cssClass: "frame-eternal" },
  glow_streak_ember: { cssClass: "streak-glow-ember" },
  glow_streak_frost: { cssClass: "streak-glow-frost" },
  glow_streak_electric: { cssClass: "streak-glow-electric" },
  glow_streak_eternal: { cssClass: "streak-glow-eternal" },
  username_streak_emerald: { cssClass: "streak-name-emerald" },
  username_streak_centurion: { cssClass: "streak-name-centurion" },
  username_streak_crimson: { cssClass: "streak-name-crimson" },
};

const PROFILE_KEYS = new Set([
  "badge_flame_14",
  "badge_flame_blue",
  "badge_365_plus",
  "frame_eternal",
  "glow_streak_ember",
  "glow_streak_frost",
  "glow_streak_electric",
  "glow_streak_eternal",
  "username_streak_emerald",
  "username_streak_centurion",
  "username_streak_crimson",
]);

function loadEquipment() {
  try {
    return {
      ...DEFAULT_EQUIPMENT,
      ...(JSON.parse(window.localStorage.getItem(EQUIPMENT_KEY) || "{}") || {}),
    };
  } catch {
    return { ...DEFAULT_EQUIPMENT };
  }
}

function saveEquipment(value) {
  try {
    window.localStorage.setItem(EQUIPMENT_KEY, JSON.stringify(value));
  } catch {}
}

let equipment = loadEquipment();
let selectedTitle = null;

function detailFor(id) {
  const board = boardItem(id);
  const profile = profileStreakItem(id);
  const rawKind =
    board?.kind ||
    profile?.kind ||
    (id.startsWith("badge_") ? "badge" : id.startsWith("frame_") ? "profile_frame" : "title");
  return {
    id,
    label: board?.label || profile?.label || (id === "title_centurion" ? "CENTURION" : id),
    kind: rawKind === "frame" ? "profile_frame" : rawKind,
    visual: VISUALS[id] || null,
  };
}

function ownedForMilestone(day) {
  return day <= CURRENT;
}

function buildLadder() {
  return STREAK_MILESTONES.map((milestone) => ({
    day: milestone.day,
    title: milestone.title || null,
    items: milestone.items.map((id) => ({
      ...detailFor(id),
      owned: ownedForMilestone(milestone.day),
    })),
    achieved: ownedForMilestone(milestone.day),
    isNext:
      STREAK_MILESTONES.find((candidate) => candidate.day > CURRENT)?.day ===
      milestone.day,
  }));
}

function buildDailyStreak() {
  const state = getStreakMilestoneState(CURRENT);
  const rewards = getStreakMilestoneState(CURRENT, { rewardLadder: true });
  return {
    success: true,
    source: "canonical",
    current: state.current,
    best: Math.max(state.current, 100),
    weeklyCurrent: 4,
    weeklyBest: 9,
    title: state.title,
    nextMilestone: rewards.nextMilestone,
    daysRemaining: rewards.daysRemaining,
    progress: rewards.progress,
    milestones: state.milestones,
    rewardMilestones: rewards.milestones,
    lastCompletedDate: "2026-11-20",
    shieldAvailable: false,
  };
}

function buildStreakMe() {
  const ladder = buildLadder();
  return {
    success: true,
    signedIn: true,
    pro: false,
    equipped: {
      felt: equipment.felt || "felt_default",
      cardBack: equipment.card_back || "card_back_default",
      deckSkin: equipment.deck_skin || "deck_default",
    },
    equippedCosmetics: { ...equipment },
    selectedSpecialTitle: selectedTitle,
    streak: {
      currentStreak: CURRENT,
      longestStreak: Math.max(CURRENT, 100),
      prestigePips: 0,
      nextMilestone: getStreakMilestoneState(CURRENT, { rewardLadder: true }).nextMilestone,
      milestones: ladder,
    },
    ladder,
    catalog: { profile: [], board: [], cardBacks: [], deckSkins: [], felts: [] },
  };
}

function profileCatalog() {
  return [...PROFILE_KEYS].map((key) => {
    const detail = detailFor(key);
    const category = detail.kind;
    return {
      key,
      name: detail.label,
      category,
      rarity: "Streak",
      visual: detail.visual,
      equipped: equipment[category] === key,
    };
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function equip(body) {
  const category = typeof body.category === "string" ? body.category : "";
  const isBoard = category === "felt" || category === "card_back" || category === "deck_skin";
  const key = body.key;

  if (isBoard) {
    const item = body.item ?? body.key;
    const defaultIds = new Set(["felt_default", "card_back_default", "deck_default"]);
    if (typeof item !== "string" || (!VISUALS[item] && !defaultIds.has(item))) {
      return json({ success: false, error: "That board reward is not owned." }, 400);
    }
    equipment = { ...equipment, [category]: item };
    saveEquipment(equipment);
    return json({ success: true, slot: category, itemId: item });
  }

  if (category && key == null) {
    equipment = { ...equipment };
    delete equipment[category];
    saveEquipment(equipment);
    return json({ success: true, equippedCosmetics: { ...equipment } });
  }

  if (typeof key !== "string" || !PROFILE_KEYS.has(key)) {
    return json({ success: false, error: "That reward is locked." }, 400);
  }
  const detail = detailFor(key);
  equipment = { ...equipment, [detail.kind]: key };
  saveEquipment(equipment);
  return json({
    success: true,
    equippedCosmetics: { ...equipment },
  });
}

function titleEquip(body) {
  const key = body.titleKey;
  if (key != null && key !== "title_centurion") {
    return json({ success: false, error: "That title is locked." }, 400);
  }
  selectedTitle = key ? String(key) : null;
  return json({ success: true, selectedSpecialTitle: selectedTitle });
}

function leaderboard(game) {
  const duel = game === "solitaire-duel";
  const base = duel
    ? [
        ["duel-alice", "Alice", 12, 2, 30, 8],
        ["duel-bob", "Bob", 12, 0, 28, 7],
        ["duel-cara", "Cara", 9, 1, 22, 5],
      ]
    : [
        ["puzzle-ana", "Ana", 8, 1, 18, 4],
        ["puzzle-ben", "Ben", 6, 0, 16, 3],
        ["puzzle-cle", "Cleo", 6, 2, 14, 2],
      ];
  const items = base.map(([clerkId, name, best, current, wins, losses], index) => ({
    rank: index + 1,
    clerk_id: clerkId,
    name,
    user: { name, icon_key: null },
    best_streak: best,
    current_streak: current,
    wins,
    losses,
    peak_total_trophies: 1200,
    playerLevel: { level: 5, rankKey: "rookie" },
  }));
  return {
    success: true,
    game,
    label: duel ? "Solitaire Ranked" : "Puzzle Ranked",
    items,
    me: items[0],
    limit: 50,
    offset: 0,
    games: [
      { key: "solitaire-duel", label: "Solitaire Ranked" },
      { key: "solitaire-puzzle", label: "Puzzle Ranked" },
    ],
  };
}

window.fetch = async (input, init = {}) => {
  const url = String(input);
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const method = (init.method || "GET").toUpperCase();

  if (SCENARIO === "loading" && (path === "/api/user/daily-streak" || path === "/api/streaks/me")) {
    return new Promise(() => {});
  }
  if (SCENARIO === "error" && path === "/api/user/daily-streak") {
    return json({ success: false, error: "Unavailable" }, 500);
  }
  if (SCENARIO === "empty" && path === "/api/streaks/me") {
    return json({ success: true, signedIn: true, ladder: [], equipped: {}, streak: {} });
  }

  if (path === "/api/user/daily-streak") {
    return json(SIGNED_IN ? buildDailyStreak() : { success: false, error: "Not authenticated" }, SIGNED_IN ? 200 : 401);
  }
  if (path === "/api/streaks/me") return json(SIGNED_IN ? buildStreakMe() : { success: true, signedIn: false });
  if (path === "/api/cosmetics" && method === "GET") {
    return json({
      success: true,
      owned: profileCatalog(),
      equipped: { ...equipment },
    });
  }
  if (path === "/api/cosmetics/equip" && method === "POST") {
    let body = {};
    try {
      body = JSON.parse(init.body || "{}");
    } catch {}
    return equip(body);
  }
  if (path === "/api/titles/equip-special" && method === "POST") {
    let body = {};
    try {
      body = JSON.parse(init.body || "{}");
    } catch {}
    return titleEquip(body);
  }
  if (path === "/api/leaderboard/competitive-streak") {
    const game = new URL(url, window.location.origin).searchParams.get("game") || "solitaire-duel";
    return json(leaderboard(game));
  }
  if (path === "/api/leaderboard/all-time") {
    return json({
      success: true,
      category: "wins",
      items: [{ rank: 1, clerk_id: "all-1", name: "Alice", user: { name: "Alice" }, wins: 30, losses: 4, current_streak: 2 }],
      me: null,
      limit: 50,
      offset: 0,
    });
  }
  if (path === "/api/user/stats") {
    return json({
      success: true,
      userStats: {
        gamesWon: 30,
        gamesLost: 4,
        gamesPlayed: 34,
        currentStreak: 2,
        bestStreak: 12,
        favoriteGame: "Solitaire Duel",
      },
    });
  }
  if (path === "/api/streaks/competitive") {
    return json({
      success: true,
      streaks: {
        "solitaire-duel": { current: 3, best: 12 },
        "solitaire-puzzle": { current: 0, best: 8 },
      },
    });
  }
  return json({ success: true });
};

function EquipmentPreview() {
  const [open, setOpen] = useState(true);
  const [state, setState] = useState(() => loadEquipment());
  const frame = state.profile_frame ? detailFor(state.profile_frame) : null;
  const glowClass = state.profile_glow ? cosmeticEffectClass(detailFor(state.profile_glow).visual) : "";
  const nameClass = state.username_effect
    ? cosmeticEffectClass(detailFor(state.username_effect).visual)
    : "";
  const ring = cosmeticFrameRing(frame?.visual);

  return (
    <main className="mx-auto max-w-4xl px-4 py-24">
      <h1 className="text-2xl font-black text-white">Equipment preview</h1>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 rounded-lg border border-cyan-300/40 px-4 py-2 text-white"
      >
        Open cosmetics
      </button>
      <div
        data-testid="equipped-preview"
        className={`mt-6 rounded-xl border border-cyan-300/30 bg-[#081420] p-6 ${glowClass || ""}`}
      >
        <div
          aria-hidden="true"
          data-testid="equipped-frame"
          className={`flex h-16 w-16 items-center justify-center rounded-full border-2 border-white/20 text-xl font-black text-white ${ring.cssClass}`}
          style={ring.style}
        >
          A
        </div>
        <p data-testid="equipped-name" className={`mt-3 text-lg font-bold ${nameClass || ""}`}>
          Alice
        </p>
        <p data-testid="equipped-glow" className={glowClass || "no-glow"}>
          Profile glow
        </p>
      </div>
      <ChooseFrameModal
        open={open}
        onClose={() => setOpen(false)}
        onEquipped={() => setState(loadEquipment())}
      />
    </main>
  );
}

function Root() {
  if (SCREEN === "classement") return <LeaderboardPage />;
  if (SCREEN === "equipment") return <EquipmentPreview />;
  return <RewardsPage />;
}

createRoot(document.getElementById("root")).render(
  <SWRConfig
    value={{
      provider: () => new Map(),
      fetcher: async (url) => {
        const response = await fetch(url);
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
        return body;
      },
      revalidateOnFocus: false,
      dedupingInterval: 0,
    }}
  >
    <LanguageProvider>
      <Root />
    </LanguageProvider>
  </SWRConfig>,
);
