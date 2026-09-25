export type TitleRarity =
  | "Common"
  | "Bronze"
  | "Silver"
  | "Gold"
  | "Elite"
  | "Mythic"
  | "Overlord";

export type TitleMilestone = {
  level: number;
  title: string;
  rarity: TitleRarity;
};

// The battlepass replaced the wager-based VIP levels (which ran to level
// 500, making everything past ~level 20 unreachable) with a 100-level EXP
// track, so the milestones are re-mapped onto levels 1–100. The full
// rarity ladder is now actually earnable.
export const TITLE_MILESTONES: TitleMilestone[] = [
  { level: 1, title: "Fresh Contender", rarity: "Common" },
  { level: 2, title: "New Challenger", rarity: "Common" },
  { level: 3, title: "Rookie", rarity: "Common" },
  { level: 4, title: "Glow Seeker", rarity: "Common" },
  { level: 5, title: "Table Wanderer", rarity: "Common" },
  { level: 6, title: "Card Hustler", rarity: "Bronze" },
  { level: 7, title: "Dice Roller", rarity: "Bronze" },
  { level: 8, title: "Apprentice", rarity: "Bronze" },
  { level: 9, title: "Prize Chaser", rarity: "Bronze" },
  { level: 10, title: "Rising Gamer", rarity: "Bronze" },
  { level: 12, title: "Bronze Contender", rarity: "Bronze" },
  { level: 14, title: "Match Captain", rarity: "Silver" },
  { level: 16, title: "Raider", rarity: "Silver" },
  { level: 18, title: "Card Bandit", rarity: "Silver" },
  { level: 20, title: "Silver Contender", rarity: "Silver" },
  { level: 23, title: "Grinder", rarity: "Gold" },
  { level: 26, title: "Top Scorer", rarity: "Gold" },
  { level: 29, title: "VIP Player", rarity: "Gold" },
  { level: 32, title: "Gold Contender", rarity: "Gold" },
  { level: 35, title: "Fortune Hunter", rarity: "Elite" },
  { level: 38, title: "Record Breaker", rarity: "Elite" },
  { level: 41, title: "Elite Player", rarity: "Elite" },
  { level: 44, title: "Diamond Contender", rarity: "Elite" },
  { level: 47, title: "Glow Tyrant", rarity: "Elite" },
  { level: 50, title: "Odds Master", rarity: "Mythic" },
  { level: 54, title: "Champion", rarity: "Mythic" },
  { level: 58, title: "Legend", rarity: "Mythic" },
  { level: 62, title: "GRYND Emperor", rarity: "Mythic" },
  { level: 66, title: "Supreme Strategist", rarity: "Mythic" },
  { level: 70, title: "Vault Lord", rarity: "Overlord" },
  { level: 74, title: "Phantom Roller", rarity: "Overlord" },
  { level: 78, title: "Tactics God", rarity: "Overlord" },
  { level: 82, title: "Tournament Slayer", rarity: "Overlord" },
  { level: 86, title: "Mythic Contender", rarity: "Overlord" },
  { level: 90, title: "Eternal Champion", rarity: "Overlord" },
  { level: 95, title: "Champion Among Champions", rarity: "Overlord" },
  { level: 98, title: "Sovereign Absolute", rarity: "Overlord" },
  { level: 99, title: "The Undefeated", rarity: "Overlord" },
  { level: 100, title: "GRYND OVERLORD", rarity: "Overlord" },
];

export function getUnlockedTitles(level: number): TitleMilestone[] {
  const normalizedLevel = Number.isFinite(level)
    ? Math.max(1, Math.floor(level))
    : 1;
  return TITLE_MILESTONES.filter(
    (milestone) => milestone.level <= normalizedLevel,
  );
}

export function getHighestTitle(level: number): TitleMilestone | null {
  const unlocked = getUnlockedTitles(level);
  return unlocked.length ? unlocked[unlocked.length - 1] : null;
}

export function getNextTitle(level: number): TitleMilestone | null {
  const normalizedLevel = Number.isFinite(level)
    ? Math.max(1, Math.floor(level))
    : 1;
  return (
    TITLE_MILESTONES.find((milestone) => milestone.level > normalizedLevel) ??
    null
  );
}

export function isTitleUnlocked(level: number, title: string): boolean {
  if (!title) return false;
  return getUnlockedTitles(level).some(
    (milestone) => milestone.title === title,
  );
}

export function getTitleByName(title: string): TitleMilestone | null {
  if (!title) return null;
  return (
    TITLE_MILESTONES.find((milestone) => milestone.title === title) ?? null
  );
}
