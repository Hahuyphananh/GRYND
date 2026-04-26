export type TitleRarity = 'Common' | 'Bronze' | 'Silver' | 'Gold' | 'Elite' | 'Mythic' | 'Overlord';

export type TitleMilestone = {
  level: number;
  title: string;
  rarity: TitleRarity;
};

export const TITLE_MILESTONES: TitleMilestone[] = [
  { level: 1, title: 'Rookie', rarity: 'Common' },
  { level: 3, title: 'Card Counter', rarity: 'Common' },
  { level: 5, title: 'Lucky Hand', rarity: 'Bronze' },
  { level: 8, title: 'High Roller', rarity: 'Bronze' },
  { level: 12, title: 'Pit Boss', rarity: 'Silver' },
  { level: 16, title: 'Jackpot Hunter', rarity: 'Silver' },
  { level: 20, title: 'Diamond Gambler', rarity: 'Gold' },
  { level: 26, title: 'Neon Emperor', rarity: 'Gold' },
  { level: 32, title: 'Velvet Dominator', rarity: 'Elite' },
  { level: 40, title: 'Phantom Whale', rarity: 'Elite' },
  { level: 50, title: 'Mythic Oracle', rarity: 'Mythic' },
  { level: 65, title: 'Apex Sovereign', rarity: 'Mythic' },
  { level: 80, title: 'Casino Overlord', rarity: 'Overlord' },
];

export function getUnlockedTitles(level: number): TitleMilestone[] {
  const normalizedLevel = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  return TITLE_MILESTONES.filter((milestone) => milestone.level <= normalizedLevel);
}

export function getHighestTitle(level: number): TitleMilestone | null {
  const unlocked = getUnlockedTitles(level);
  return unlocked.length ? unlocked[unlocked.length - 1] : null;
}

export function getNextTitle(level: number): TitleMilestone | null {
  const normalizedLevel = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  return TITLE_MILESTONES.find((milestone) => milestone.level > normalizedLevel) ?? null;
}

export function isTitleUnlocked(level: number, title: string): boolean {
  if (!title) return false;
  return getUnlockedTitles(level).some((milestone) => milestone.title === title);
}

export function getTitleByName(title: string): TitleMilestone | null {
  if (!title) return null;
  return TITLE_MILESTONES.find((milestone) => milestone.title === title) ?? null;
}
