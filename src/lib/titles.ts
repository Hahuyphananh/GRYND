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

export const TITLE_MILESTONES: TitleMilestone[] = [
  { level: 1, title: "Newbie Goon", rarity: "Common" },
  { level: 5, title: "New Challenger", rarity: "Common" },
  { level: 10, title: "Rookie", rarity: "Common" },
  { level: 15, title: "Coin Collector", rarity: "Common" },
  { level: 20, title: "Table Wanderer", rarity: "Common" },
  { level: 25, title: "Card Hustler", rarity: "Bronze" },
  { level: 30, title: "Dice Roller", rarity: "Bronze" },
  { level: 35, title: "Apprentice", rarity: "Bronze" },
  { level: 40, title: "Prize Chaser", rarity: "Bronze" },
  { level: 45, title: "Rising Gamer", rarity: "Bronze" },
  { level: 50, title: "Bronze Goon", rarity: "Bronze" },
  { level: 60, title: "Match Captain", rarity: "Silver" },
  { level: 70, title: "Raider", rarity: "Silver" },
  { level: 80, title: "Card Bandit", rarity: "Silver" },
  { level: 90, title: "Silver Goon", rarity: "Silver" },
  { level: 100, title: "Grinder", rarity: "Gold" },
  { level: 115, title: "Top Scorer", rarity: "Gold" },
  { level: 130, title: "VIP Player", rarity: "Gold" },
  { level: 145, title: "Gold Goon", rarity: "Gold" },
  { level: 160, title: "Fortune Hunter", rarity: "Elite" },
  { level: 175, title: "Record Breaker", rarity: "Elite" },
  { level: 190, title: "Elite Player", rarity: "Elite" },
  { level: 205, title: "Diamond Goon", rarity: "Elite" },
  { level: 220, title: "Token Tyrant", rarity: "Elite" },
  { level: 235, title: "Odds Master", rarity: "Mythic" },
  { level: 250, title: "Champion", rarity: "Mythic" },
  { level: 270, title: "Legend", rarity: "Mythic" },
  { level: 290, title: "Goon Emperor", rarity: "Mythic" },
  { level: 310, title: "Supreme Strategist", rarity: "Mythic" },
  { level: 330, title: "Vault Lord", rarity: "Overlord" },
  { level: 350, title: "Phantom Roller", rarity: "Overlord" },
  { level: 370, title: "Tactics God", rarity: "Overlord" },
  { level: 390, title: "Tournament Slayer", rarity: "Overlord" },
  { level: 410, title: "Mythic Goon", rarity: "Overlord" },
  { level: 430, title: "Eternal Champion", rarity: "Overlord" },
  { level: 450, title: "Champion Among Champions", rarity: "Overlord" },
  { level: 475, title: "Sovereign Absolute", rarity: "Overlord" },
  { level: 490, title: "The Undefeated", rarity: "Overlord" },
  { level: 500, title: "GOONBET OVERLORD", rarity: "Overlord" },
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
