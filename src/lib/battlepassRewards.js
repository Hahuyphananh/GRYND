// src/lib/battlepassRewards.js
//
// Per-level battlepass rewards. Small rewards early, rare rewards at the
// end. Official image-based rewards reference stable catalog keys.
//
// Reserved-empty levels (future icons, frames, banners, and other cosmetics):
//   9, 17, 27, 36, 49, 61, 67, 73, 86, 93, 97
// (6, 13, 22, 31, 42, 56 and 81 used to be reserved-empty too, but now hold
// the official animated emote rewards — the 7 Battle Pass Noto emotes.)

// Reward type metadata (label + accent color used in the UI legend).
export const REWARD_TYPES = {
  color: { label: "Name Glow", color: "#22d3ee" },
  title: { label: "Title", color: "#f5c542" },
  xp_boost: { label: "XP Boost", color: "#a3e635" },
  quest_boost: { label: "Quest Boost", color: "#34d399" },
  shield: { label: "Streak Shield", color: "#38bdf8" },
  refund: { label: "Loss Refund", color: "#f472b6" },
  grynd: { label: "Grynd+ Days", color: "#a78bfa" },
  banner: { label: "Profile Banner", color: "#22d3ee" },
  emote: { label: "Animated Emote", color: "#22d3ee" },
};

// Reward rarity colors (matches the title rarity ladder).
export const REWARD_RARITIES = {
  Common: "#9ca3af",
  Bronze: "#cd7f32",
  Silver: "#c0c0c0",
  Gold: "#f5c542",
  Elite: "#a78bfa",
  Mythic: "#f472b6",
  Overlord: "#f59e0b",
};

// [level, rewards[]] — levels not listed are reserved-empty.
const REWARDS = [
  [1, [{ type: "color", key: "cyan", name: "Cyan Glow", desc: "Unlock the cyan name glow", value: "#00e5ff", rarity: "Common" }]],
  [2, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [3, [{ type: "banner", key: "neon-grid", name: "Neon Grid", desc: "Unlock the Neon Grid profile banner", rarity: "Common" }]],
  [4, [{ type: "title", key: "bp_pass_starter", name: "Pass Starter", desc: "Battlepass-exclusive title", rarity: "Common" }]],
  [5, [{ type: "color", key: "lime", name: "Lime Glow", desc: "Unlock the lime name glow", value: "#a3e635", rarity: "Common" }]],
  [6, [{ type: "emote", key: "hype", name: "Hype Emote", desc: "Unlock the animated Hype emote for in-game use", rarity: "Common" }]],
  [7, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [8, [{ type: "color", key: "violet", name: "Violet Glow", desc: "Unlock the violet name glow", value: "#a78bfa", rarity: "Common" }]],
  [10, [{ type: "title", key: "bp_token_shuffler", name: "Token Shuffler", desc: "Battlepass-exclusive title", rarity: "Common" }]],
  [11, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [12, [{ type: "color", key: "rose", name: "Rose Glow", desc: "Unlock the rose name glow", value: "#f472b6", rarity: "Common" }]],
  [13, [{ type: "emote", key: "victory", name: "Victory Emote", desc: "Unlock the animated Victory emote for in-game use", rarity: "Bronze" }]],
  [14, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 3 quest claims pay double", value: 3, rarity: "Common" }]],
  [15, [{ type: "color", key: "amber", name: "Amber Glow", desc: "Unlock the amber name glow", value: "#fbbf24", rarity: "Common" }]],
  [16, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [18, [{ type: "title", key: "bp_quest_completist", name: "Quest Completist", desc: "Battlepass-exclusive title", rarity: "Common" }]],
  [19, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 500 tokens", value: 500, rarity: "Common" }]],
  [20, [{ type: "color", key: "emerald", name: "Emerald Glow", desc: "Unlock the emerald name glow", value: "#34d399", rarity: "Common" }]],
  [21, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [22, [{ type: "emote", key: "party", name: "Party Emote", desc: "Unlock the animated Party emote for in-game use", rarity: "Bronze" }]],
  [23, [{ type: "color", key: "crimson", name: "Crimson Glow", desc: "Unlock the crimson name glow", value: "#f87171", rarity: "Common" }]],
  [24, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [25, [{ type: "title", key: "bp_wager_warrior", name: "Wager Warrior", desc: "Battlepass-exclusive title", rarity: "Bronze" }]],
  [26, [{ type: "color", key: "sky", name: "Sky Glow", desc: "Unlock the sky name glow", value: "#38bdf8", rarity: "Common" }]],
  [28, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 3 quest claims pay double", value: 3, rarity: "Common" }]],
  [29, [{ type: "color", key: "magenta", name: "Magenta Glow", desc: "Unlock the magenta name glow", value: "#e879f9", rarity: "Common" }]],
  [30, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [31, [{ type: "emote", key: "skull", name: "Skull Emote", desc: "Unlock the animated Skull emote for in-game use", rarity: "Silver" }]],
  [32, [{ type: "color", key: "ocean", name: "Ocean Glow", desc: "Unlock the ocean name glow", value: "#2dd4bf", rarity: "Common" }]],
  [33, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 750 tokens", value: 750, rarity: "Common" }]],
  [34, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [35, [{ type: "title", key: "bp_streak_sentinel", name: "Streak Sentinel", desc: "Battlepass-exclusive title", rarity: "Bronze" }]],
  [37, [{ type: "color", key: "gold", name: "Gold Glow", desc: "Unlock the gold name glow", value: "#facc15", rarity: "Common" }]],
  [38, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 5 quest claims pay double", value: 5, rarity: "Bronze" }]],
  [39, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [40, [{ type: "color", key: "platinum", name: "Platinum Glow", desc: "Unlock the platinum name glow", value: "#e2e8f0", rarity: "Common" }]],
  [41, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 48h", value: { multiplier: 2, hours: 48 }, rarity: "Bronze" }]],
  [42, [{ type: "emote", key: "thumbsup", name: "Thumbs Up Emote", desc: "Unlock the animated Thumbs Up emote for in-game use", rarity: "Silver" }]],
  [43, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 1,000 tokens", value: 1000, rarity: "Bronze" }]],
  [44, [{ type: "title", key: "bp_pass_raider", name: "Pass Raider", desc: "Battlepass-exclusive title", rarity: "Silver" }]],
  [45, [{ type: "color", key: "ruby", name: "Ruby Glow", desc: "Unlock the ruby name glow", value: "#fb7185", rarity: "Common" }]],
  [46, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 5 quest claims pay double", value: 5, rarity: "Bronze" }]],
  [47, [{ type: "grynd", name: "3 Days of Grynd+", desc: "Free Grynd+ membership for 3 days", value: 3, rarity: "Silver" }]],
  [48, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 48h", value: { multiplier: 2, hours: 48 }, rarity: "Bronze" }]],
  [50, [{ type: "title", key: "bp_glow_bearer", name: "Glow Bearer", desc: "Battlepass-exclusive title", rarity: "Silver" }]],
  [51, [{ type: "color", key: "royal", name: "Royal Glow", desc: "Unlock the royal name glow", value: "#818cf8", rarity: "Common" }]],
  [52, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [53, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 1,500 tokens", value: 1500, rarity: "Bronze" }]],
  [54, [{ type: "xp_boost", name: "3× XP Boost", desc: "Triple battlepass XP for 24h", value: { multiplier: 3, hours: 24 }, rarity: "Silver" }]],
  [55, [{ type: "color", key: "sunfire", name: "Sunfire Glow", desc: "Unlock the sunfire name glow", value: "#fb923c", rarity: "Common" }]],
  [56, [{ type: "emote", key: "clap", name: "Clap Emote", desc: "Unlock the animated Clap emote for in-game use", rarity: "Gold" }]],
  [57, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 5 quest claims pay double", value: 5, rarity: "Bronze" }]],
  [58, [{ type: "title", key: "bp_lucky_gambit", name: "Lucky Gambit", desc: "Battlepass-exclusive title", rarity: "Gold" }]],
  [59, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [60, [{ type: "color", key: "golden_flame", name: "Golden Flame", desc: "Unlock the golden flame name glow", value: "#fde047", rarity: "Common" }]],
  [62, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 72h", value: { multiplier: 2, hours: 72 }, rarity: "Silver" }]],
  [63, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 1,500 tokens", value: 1500, rarity: "Silver" }]],
  [64, [{ type: "grynd", name: "7 Days of Grynd+", desc: "Free Grynd+ membership for 7 days", value: 7, rarity: "Gold" }]],
  [65, [{ type: "color", key: "aurora", name: "Aurora Glow", desc: "Unlock the aurora name glow", value: "#67e8f9", rarity: "Common" }]],
  [66, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 7 quest claims pay double", value: 7, rarity: "Silver" }]],
  [68, [{ type: "title", key: "bp_battlepass_titan", name: "Battlepass Titan", desc: "Battlepass-exclusive title", rarity: "Gold" }]],
  [69, [{ type: "xp_boost", name: "3× XP Boost", desc: "Triple battlepass XP for 48h", value: { multiplier: 3, hours: 48 }, rarity: "Gold" }]],
  [70, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [71, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 2,500 tokens", value: 2500, rarity: "Silver" }]],
  [72, [{ type: "color", key: "inferno", name: "Inferno Glow", desc: "Unlock the inferno name glow", value: "#f97316", rarity: "Common" }]],
  [74, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 7 quest claims pay double", value: 7, rarity: "Silver" }]],
  [75, [{ type: "title", key: "bp_high_roller_legend", name: "High Roller Legend", desc: "Battlepass-exclusive title", rarity: "Elite" }]],
  [76, [{ type: "grynd", name: "7 Days of Grynd+", desc: "Free Grynd+ membership for 7 days", value: 7, rarity: "Gold" }]],
  [77, [{ type: "xp_boost", name: "2× XP Boost", desc: "Double battlepass XP for 96h", value: { multiplier: 2, hours: 96 }, rarity: "Gold" }]],
  [78, [{ type: "color", key: "nebula", name: "Nebula Glow", desc: "Unlock the nebula name glow", value: "#c084fc", rarity: "Common" }]],
  [79, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [80, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 2,500 tokens", value: 2500, rarity: "Gold" }]],
  [81, [{ type: "emote", key: "star", name: "Star Emote", desc: "Unlock the animated Star emote for in-game use", rarity: "Elite" }]],
  [82, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 7 quest claims pay double", value: 7, rarity: "Gold" }]],
  [83, [{ type: "title", key: "bp_aurora_master", name: "Aurora Master", desc: "Battlepass-exclusive title", rarity: "Mythic" }]],
  [84, [{ type: "xp_boost", name: "3× XP Boost", desc: "Triple battlepass XP for 72h", value: { multiplier: 3, hours: 72 }, rarity: "Gold" }]],
  [85, [{ type: "color", key: "solar_flare", name: "Solar Flare", desc: "Unlock the solar flare name glow", value: "#fdba74", rarity: "Common" }]],
  [87, [{ type: "grynd", name: "14 Days of Grynd+", desc: "Free Grynd+ membership for 14 days", value: 14, rarity: "Elite" }]],
  [88, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [89, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 10 quest claims pay double", value: 10, rarity: "Gold" }]],
  [90, [{ type: "color", key: "starfire", name: "Starfire Glow", desc: "Unlock the starfire name glow", value: "#fde68a", rarity: "Common" }]],
  [91, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 5,000 tokens", value: 5000, rarity: "Elite" }]],
  [92, [{ type: "xp_boost", name: "3× XP Boost", desc: "Triple battlepass XP for 72h", value: { multiplier: 3, hours: 72 }, rarity: "Elite" }]],
  [94, [{ type: "shield", name: "Ultimate Streak Shield", desc: "Protects your streak for 3 missed days", value: 3, rarity: "Elite" }]],
  [95, [{ type: "color", key: "celestial", name: "Celestial Glow", desc: "Unlock the celestial name glow", value: "#93c5fd", rarity: "Common" }]],
  [96, [{ type: "quest_boost", name: "Quest Boost", desc: "Next 10 quest claims pay double", value: 10, rarity: "Elite" }]],
  [98, [{ type: "xp_boost", name: "3× XP Boost", desc: "Triple battlepass XP for 96h", value: { multiplier: 3, hours: 96 }, rarity: "Elite" }]],
  [99, [{ type: "refund", name: "Loss Refund", desc: "Refund one losing bet up to 10,000 tokens", value: 10000, rarity: "Mythic" }]],
  [100, [
    { type: "title", key: "bp_grynd_pass_legend", name: "GRYND PASS LEGEND", desc: "The ultimate battlepass title", rarity: "Overlord" },
    { type: "color", key: "golden_name", name: "Golden Name Glow", desc: "Permanent golden name glow — the mark of a legend", value: "#f5ff3b", rarity: "Overlord" },
  ]],
];

export const RESERVED_LEVELS = [9, 17, 27, 36, 49, 61, 67, 73, 86, 93, 97];

// ── Premium track (Grynd+ membership) ─────────────────────────────────────
// Rewards gated behind an active Grynd+ subscription. The split reuses the
// existing catalog — no new content — so the membership instantly adds
// battlepass value:
//
//   * Premium: the functional gameplay rewards (XP boosts, quest boosts,
//     streak shields — 34 slots) + the 4 Silver-and-up animated emotes
//     (skull, thumbs up, clap, star). These are the high-value rewards
//     members can actually claim (they grant the item-shop inventory).
//   * Free: all titles, all name glows, the Neon Grid banner, the 3 early
//     emotes (hype, victory, party), and the Level-100 capstone — the free
//     track still reads as a complete progression, and free players still
//     get claimable titles.
//
// Note: refund / grynd rewards stay on the free track as decoration — they
// have no grant path yet (loss refunds need a settlement hook; Grynd+ days
// need membership-day logic). Gating them would show locked rewards nobody
// can claim.
//
// Grandfathering: ownership is checked BEFORE the premium gate in the claim
// route, so anyone who already earned a premium reward keeps it forever —
// even after their membership lapses. Nothing is ever revoked.
const PREMIUM_TYPES = new Set(["xp_boost", "quest_boost", "shield"]);
const PREMIUM_EMOTE_KEYS = new Set(["skull", "thumbsup", "clap", "star"]);

export function isPremiumReward(reward) {
  if (!reward) return false;
  if (PREMIUM_TYPES.has(reward.type)) return true;
  if (reward.type === "emote" && PREMIUM_EMOTE_KEYS.has(reward.key)) return true;
  return false;
}

// Build the 100-entry track: { level, rewards: [] } — empty array = reserved.
// Premium rewards carry `premium: true` (stamped here, not in the source
// list, so free rewards stay byte-identical for existing consumers/tests).
export const BATTLEPASS_REWARDS = (() => {
  const track = [];
  for (let level = 1; level <= 100; level++) {
    const entry = REWARDS.find(([lvl]) => lvl === level);
    const rewards = (entry ? entry[1] : []).map((reward) =>
      isPremiumReward(reward) ? { ...reward, premium: true } : reward,
    );
    track.push({ level, rewards });
  }
  return track;
})();

export function rewardsForLevel(level) {
  return BATTLEPASS_REWARDS[level - 1]?.rewards || [];
}
