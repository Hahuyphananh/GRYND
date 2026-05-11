// Infinite VIP system (exponential growth)

const BASE_REQUIREMENT = 1000; // tokens for level 2
const GROWTH_FACTOR = 1.35; // tweak this (1.25–1.5 is good)

// total wager required to REACH a level
export function getRequiredForLevel(level) {
  if (level <= 1) return 0;

  return Math.floor(BASE_REQUIREMENT * Math.pow(GROWTH_FACTOR, level - 2));
}

// get level from total wagered (infinite)
export function getUserLevel(totalWagered = 0) {
  const wagered = Number(totalWagered) || 0;

  let level = 1;

  while (true) {
    const nextRequirement = getRequiredForLevel(level + 1);

    if (wagered < nextRequirement) break;

    level++;
  }

  return level;
}

export function getLevelProgress(totalWagered = 0) {
  const wagered = Number(totalWagered) || 0;

  const currentLevel = getUserLevel(wagered);

  const prevRequired = getRequiredForLevel(currentLevel);
  const nextRequired = getRequiredForLevel(currentLevel + 1);

  const range = nextRequired - prevRequired;
  const progress = wagered - prevRequired;

  const progressPercent =
    range > 0 ? Math.min(100, (progress / range) * 100) : 100;

  return {
    currentLevel,
    progressPercent,
    prevLevelRequired: prevRequired,
    nextLevelRequired: nextRequired,
    remainingToNext: Math.max(0, nextRequired - wagered),
  };
}
