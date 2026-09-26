// src/lib/battlepassRewards.js
//
// Per-level battlepass rewards. Small rewards early, rare rewards at the
// end. Official image-based rewards reference stable catalog keys.
//
// Reward philosophy: PLAY → EARN TROPHIES → PROGRESS → UNLOCK COSMETIC/PROFILE
// REWARDS. There is NO currency on this track — every reward is either
// an owned/equippable cosmetic (name glows, animated emotes, profile
// frames/badges/effects), a title, or a purely progression perk (XP boost /
// streak shield). Nothing here
// grants gameplay, stat, Elo or matchmaking advantages, and nothing replaces
// a GRYND PRO feature.
//
// Every level 1–100 now carries at least one reward. The filler levels use
// flat `battlepass_xp` so the track stays manageable and scalable — not every
// level needs a unique cosmetic. Cosmetic grants sit at the milestone levels
// (badges / frames / avatar + username + chat effects), reusing the existing
// catalogs: `glows` (0149), `emotes` (0138) and `cosmetics` (0156).
// (6, 13, 22, 31, 42, 56 and 81 hold the official animated emote rewards —
// the 7 Battle Pass Noto emotes.)
//
// NOTE: new frames / glows / emotes are added by seeding a new catalog row
// (a migration into `cosmetics` / `glows` / `emotes`) and then adding the
// matching reward entry here with that key — never by inventing an asset URL
// or a placeholder graphic. A reward key with no catalog row is skipped
// cleanly by the claim route (see grantCosmetic) instead of erroring.

// Reward type metadata (label + accent color used in the UI legend).
export const REWARD_TYPES = {
  color: { label: "Name Glow", color: "#22d3ee" },
  title: { label: "Title", color: "#f5c542" },
  xp_boost: { label: "Progress Boost", color: "#a3e635" },
  shield: { label: "Streak Shield", color: "#38bdf8" },
  grynd: { label: "GRYND PRO Days", color: "#a78bfa" },
  emote: { label: "Animated Emote", color: "#22d3ee" },
  battlepass_xp: { label: "Battle Pass", color: "#a3e635" },
  cosmetic: { label: "Cosmetic", color: "#a78bfa" },
};

// The cosmetic reward types share one grant mechanism (user_cosmetics
// ownership through src/lib/cosmetics.ts). Kept as explicit type names so
// tracks stay readable and the UI legend can label each one.
export const COSMETIC_REWARD_TYPES = new Set([
  "badge",
  "profile_frame",
  "avatar_effect",
  "username_effect",
  "chat_effect",
  "profile_glow",
  "prestige_effect",
  "cosmetic",
]);

// Reward rarity colors. The title ladder (Common → Overlord) plus the two
// item-shop rarities the cosmetic battlepass rewards reuse (Rare / Epic — see
// src/lib/shopItems.js). Every rarity the track references must have a color
// here, or the track's dot/accent falls back to a flat grey.
export const REWARD_RARITIES = {
  Common: "#9ca3af",
  Bronze: "#cd7f32",
  Silver: "#c0c0c0",
  Rare: "#60a5fa",
  Gold: "#f5c542",
  Elite: "#a78bfa",
  Epic: "#e879f9",
  Mythic: "#f472b6",
  Overlord: "#f59e0b",
};

// [level, rewards[]] — levels not listed are reserved-empty.
const REWARDS = [
  [1, [{ type: "color", key: "cyan", name: "Cyan Glow", desc: "Unlock the cyan name glow", value: "#00e5ff", rarity: "Common" }]],
  [2, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [3, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [4, [{ type: "title", key: "bp_pass_starter", name: "Pass Starter", desc: "Battlepass-exclusive title", rarity: "Common" }]],
  [5, [{ type: "color", key: "lime", name: "Lime Glow", desc: "Unlock the lime name glow", value: "#a3e635", rarity: "Common" }]],
  [6, [{ type: "emote", key: "hype", name: "Hype Emote", desc: "Unlock the animated Hype emote for in-game use", rarity: "Common" }]],
  [7, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [8, [{ type: "color", key: "violet", name: "Violet Glow", desc: "Unlock the violet name glow", value: "#a78bfa", rarity: "Common" }]],
  // [9] reserved — XP reward retired (replacement TBD).
  [10, [{ type: "title", key: "bp_pass_climber", name: "Pass Climber", desc: "Battlepass-exclusive title", rarity: "Common" }]],
  [11, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [12, [{ type: "color", key: "rose", name: "Rose Glow", desc: "Unlock the rose name glow", value: "#f472b6", rarity: "Common" }]],
  [13, [{ type: "emote", key: "victory", name: "Victory Emote", desc: "Unlock the animated Victory emote for in-game use", rarity: "Bronze" }]],
  // [14] reserved — quest reward retired (Quest system removed).
  [15, [{ type: "color", key: "amber", name: "Amber Glow", desc: "Unlock the amber name glow", value: "#fbbf24", rarity: "Common" }]],
  [16, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  // [17] reserved — XP reward retired (replacement TBD).
  [18, [{ type: "title", key: "bp_quest_completist", name: "Quest Completist", desc: "Battlepass-exclusive title", rarity: "Common" }]],
  // [19] reserved — XP reward retired (replacement TBD).
  [20, [{ type: "color", key: "emerald", name: "Emerald Glow", desc: "Unlock the emerald name glow", value: "#34d399", rarity: "Common" },
    { type: "badge", key: "badge-grynd-og", name: "GRYND OG", desc: "Earned the old-school way. Show it off.", rarity: "Common" }]],
  [21, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [22, [{ type: "emote", key: "party", name: "Party Emote", desc: "Unlock the animated Party emote for in-game use", rarity: "Bronze" }]],
  [23, [{ type: "color", key: "crimson", name: "Crimson Glow", desc: "Unlock the crimson name glow", value: "#f87171", rarity: "Common" }]],
  [24, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [25, [{ type: "title", key: "bp_wager_warrior", name: "Wager Warrior", desc: "Battlepass-exclusive title", rarity: "Bronze" }]],
  [26, [{ type: "color", key: "sky", name: "Sky Glow", desc: "Unlock the sky name glow", value: "#38bdf8", rarity: "Common" }]],
  // [27] reserved — XP reward retired (replacement TBD).
  // [28] reserved — quest reward retired (Quest system removed).
  [29, [{ type: "color", key: "magenta", name: "Magenta Glow", desc: "Unlock the magenta name glow", value: "#e879f9", rarity: "Common" }]],
  [30, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [31, [{ type: "emote", key: "skull", name: "Skull Emote", desc: "Unlock the animated Skull emote for in-game use", rarity: "Silver" }]],
  [32, [{ type: "color", key: "ocean", name: "Ocean Glow", desc: "Unlock the ocean name glow", value: "#2dd4bf", rarity: "Common" }]],
  // [33] reserved — XP reward retired (replacement TBD).
  [34, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 24h", value: { multiplier: 2, hours: 24 }, rarity: "Common" }]],
  [35, [{ type: "title", key: "bp_streak_sentinel", name: "Streak Sentinel", desc: "Battlepass-exclusive title", rarity: "Bronze" }]],
  // [36] reserved — XP reward retired (replacement TBD).
  [37, [{ type: "color", key: "gold", name: "Gold Glow", desc: "Unlock the gold name glow", value: "#facc15", rarity: "Common" }]],
  // [38] reserved — quest reward retired (Quest system removed).
  [39, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [40, [{ type: "color", key: "platinum", name: "Platinum Glow", desc: "Unlock the platinum name glow", value: "#e2e8f0", rarity: "Common" }]],
  [41, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 48h", value: { multiplier: 2, hours: 48 }, rarity: "Bronze" }]],
  [42, [{ type: "emote", key: "thumbsup", name: "Thumbs Up Emote", desc: "Unlock the animated Thumbs Up emote for in-game use", rarity: "Silver" }]],
  // [43] reserved — XP reward retired (replacement TBD).
  [44, [{ type: "title", key: "bp_pass_raider", name: "Pass Raider", desc: "Battlepass-exclusive title", rarity: "Silver" }]],
  [45, [{ type: "color", key: "ruby", name: "Ruby Glow", desc: "Unlock the ruby name glow", value: "#fb7185", rarity: "Common" }]],
  // [46] reserved — quest reward retired (Quest system removed).
  [47, [{ type: "grynd", name: "3 Days of GRYND PRO", desc: "Free GRYND PRO membership for 3 days", value: 3, rarity: "Silver" }]],
  [48, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 48h", value: { multiplier: 2, hours: 48 }, rarity: "Bronze" }]],
  [49, [{ type: "profile_frame", key: "frame-platinum", name: "Platinum Frame", desc: "A bright platinum-plated profile frame.", rarity: "Rare" }]],
  [50, [{ type: "title", key: "bp_glow_bearer", name: "Glow Bearer", desc: "Battlepass-exclusive title", rarity: "Silver" },
    { type: "badge", key: "badge-veteran", name: "Battle Pass Vet", desc: "Conquered the Battle Pass. Twice or more.", rarity: "Rare" }]],
  [51, [{ type: "color", key: "royal", name: "Royal Glow", desc: "Unlock the royal name glow", value: "#818cf8", rarity: "Common" }]],
  [52, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  // [53] reserved — XP reward retired (replacement TBD).
  [54, [{ type: "xp_boost", name: "3× Progress Boost", desc: "3× progression for 24h", value: { multiplier: 3, hours: 24 }, rarity: "Silver" }]],
  [55, [{ type: "color", key: "sunfire", name: "Sunfire Glow", desc: "Unlock the sunfire name glow", value: "#fb923c", rarity: "Common" }]],
  [56, [{ type: "emote", key: "clap", name: "Clap Emote", desc: "Unlock the animated Clap emote for in-game use", rarity: "Gold" }]],
  // [57] reserved — quest reward retired (Quest system removed).
  [58, [{ type: "title", key: "bp_lucky_gambit", name: "Lucky Gambit", desc: "Battlepass-exclusive title", rarity: "Gold" }]],
  [59, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [60, [{ type: "color", key: "golden_flame", name: "Golden Flame", desc: "Unlock the golden flame name glow", value: "#fde047", rarity: "Common" },
    { type: "profile_frame", key: "frame-neon-edge", name: "Neon Edge Frame", desc: "A cyan neon frame around your profile avatar.", rarity: "Common" }]],
  // [61] reserved — XP reward retired (replacement TBD).
  [62, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 72h", value: { multiplier: 2, hours: 72 }, rarity: "Silver" }]],
  [63, [{ type: "avatar_effect", key: "avatar-soft-aura", name: "Soft Aura", desc: "Gentle ambient glow around your avatar.", rarity: "Common" }]],
  [64, [{ type: "grynd", name: "7 Days of GRYND PRO", desc: "Free GRYND PRO membership for 7 days", value: 7, rarity: "Gold" }]],
  [65, [{ type: "color", key: "aurora", name: "Aurora Glow", desc: "Unlock the aurora name glow", value: "#67e8f9", rarity: "Common" }]],
  // [66] reserved — quest reward retired (Quest system removed).
  // [67] reserved — XP reward retired (replacement TBD).
  [68, [{ type: "title", key: "bp_battlepass_titan", name: "Battlepass Titan", desc: "Battlepass-exclusive title", rarity: "Gold" }]],
  [69, [{ type: "xp_boost", name: "3× Progress Boost", desc: "3× progression for 48h", value: { multiplier: 3, hours: 48 }, rarity: "Gold" }]],
  [70, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [71, [{ type: "username_effect", key: "username-shimmer", name: "Shimmer Name", desc: "Your name plays a shimmering gradient.", rarity: "Rare" }]],
  [72, [{ type: "color", key: "inferno", name: "Inferno Glow", desc: "Unlock the inferno name glow", value: "#f97316", rarity: "Common" }]],
  // [73] reserved — XP reward retired (replacement TBD).
  // [74] reserved — quest reward retired (Quest system removed).
  [75, [{ type: "title", key: "bp_apex_legend", name: "Apex Legend", desc: "Battlepass-exclusive title", rarity: "Elite" }]],
  [76, [{ type: "grynd", name: "7 Days of GRYND PRO", desc: "Free GRYND PRO membership for 7 days", value: 7, rarity: "Gold" }]],
  [77, [{ type: "xp_boost", name: "2× Progress Boost", desc: "2× progression for 96h", value: { multiplier: 2, hours: 96 }, rarity: "Gold" }]],
  [78, [{ type: "color", key: "nebula", name: "Nebula Glow", desc: "Unlock the nebula name glow", value: "#c084fc", rarity: "Common" }]],
  [79, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  [80, [{ type: "avatar_effect", key: "avatar-pulse", name: "Status Pulse", desc: "A steady pulse behind your avatar.", rarity: "Rare" }]],
  [81, [{ type: "emote", key: "star", name: "Star Emote", desc: "Unlock the animated Star emote for in-game use", rarity: "Elite" }]],
  // [82] reserved — quest reward retired (Quest system removed).
  [83, [{ type: "title", key: "bp_aurora_master", name: "Aurora Master", desc: "Battlepass-exclusive title", rarity: "Mythic" }]],
  [84, [{ type: "xp_boost", name: "3× Progress Boost", desc: "3× progression for 72h", value: { multiplier: 3, hours: 72 }, rarity: "Gold" }]],
  [85, [{ type: "color", key: "solar_flare", name: "Solar Flare", desc: "Unlock the solar flare name glow", value: "#fdba74", rarity: "Common" }]],
  [86, [{ type: "profile_frame", key: "frame-inferno", name: "Inferno Frame", desc: "A smoldering fire frame for serious competitors.", rarity: "Epic" }]],
  [87, [{ type: "grynd", name: "14 Days of GRYND PRO", desc: "Free GRYND PRO membership for 14 days", value: 14, rarity: "Elite" }]],
  [88, [{ type: "shield", name: "Daily Streak Shield", desc: "Protects your daily streak for one missed day", value: 1, rarity: "Common" }]],
  // [89] reserved — quest reward retired (Quest system removed).
  [90, [{ type: "color", key: "starfire", name: "Starfire Glow", desc: "Unlock the starfire name glow", value: "#fde68a", rarity: "Common" },
    { type: "profile_glow", key: "profile-aura", name: "Profile Aura", desc: "A soft aura ringing the whole profile card.", rarity: "Rare" }]],
  // [91] reserved — XP reward retired (replacement TBD).
  [92, [{ type: "xp_boost", name: "3× Progress Boost", desc: "3× progression for 72h", value: { multiplier: 3, hours: 72 }, rarity: "Elite" }]],
  // [93] reserved — XP reward retired (replacement TBD).
  [94, [{ type: "shield", name: "Ultimate Streak Shield", desc: "Protects your streak for 3 missed days", value: 3, rarity: "Elite" }]],
  [95, [{ type: "color", key: "celestial", name: "Celestial Glow", desc: "Unlock the celestial name glow", value: "#93c5fd", rarity: "Common" }]],
  // [96] reserved — quest reward retired (Quest system removed).
  // [97] reserved — XP reward retired (replacement TBD).
  [98, [{ type: "xp_boost", name: "3× Progress Boost", desc: "3× progression for 96h", value: { multiplier: 3, hours: 96 }, rarity: "Elite" }]],
  // [99] reserved — XP reward retired (replacement TBD).
  [100, [
    { type: "title", key: "bp_grynd_pass_legend", name: "GRYND PASS LEGEND", desc: "The ultimate battlepass title", rarity: "Overlord" },
    { type: "color", key: "golden_name", name: "Golden Name Glow", desc: "Permanent golden name glow — the mark of a legend", value: "#f5ff3b", rarity: "Overlord" },
    { type: "chat_effect", key: "chat-shimmer", name: "Legend Chat Name", desc: "Golden shimmer on your chat name.", rarity: "Epic" },
  ]],
];

// Levels deliberately left without a reward. The flat Battle Pass XP rewards
// were retired when the Battle Pass moved to trophy-based progression, so
// these levels are now reserved until their replacements are specified.
export const RESERVED_LEVELS = [
  9, 14, 17, 19, 27, 28, 33, 36, 38, 43, 46, 53, 57, 61, 66, 67, 73, 74, 82,
  89, 91, 93, 96, 97, 99,
];

// ── Premium track (GRYND PRO membership) ──────────────────────────────────
// Rewards gated behind an active GRYND PRO subscription. The split reuses the
// existing catalog — no new content — so the membership instantly adds
// battlepass value:
//
//   * Premium: the functional gameplay rewards (XP boosts, streak shields)
//     + the 4 Silver-and-up animated emotes
//     (skull, thumbs up, clap, star). These are the high-value rewards
//     members can actually claim (they grant the item-shop inventory).
//   * Free: all titles, all name glows, all flat Battle Pass XP rewards, the
//     official cosmetics (frames / badges / effects), the 3 early emotes
//     (hype, victory, party), and the Level-100 capstone — the free track
//     still reads as a complete progression, and free players still get
//     claimable rewards.
//
// Note: the Daily Streak Shield at level 3 is premium (like every shield),
// so non-members see it locked until they subscribe. grynd rewards (free
// GRYND PRO membership trials) stay on the free track — gating them would show
// locked rewards members can't claim for a membership they'd be buying.
//
// Grandfathering: ownership is checked BEFORE the premium gate in the claim
// route, so anyone who already earned a premium reward keeps it forever —
// even after their membership lapses. Nothing is ever revoked.
const PREMIUM_TYPES = new Set(["xp_boost", "shield"]);
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
