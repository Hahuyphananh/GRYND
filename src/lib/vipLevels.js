export const VIP_LEVELS = [
  { level: 1, required: 0 },
  { level: 2, required: 1000 },
  { level: 3, required: 5000 },
  { level: 4, required: 20000 },
  { level: 5, required: 50000 },
  { level: 6, required: 100000 },
];

export function getUserLevel(totalWagered = 0) {
  const wagered = Number(totalWagered) || 0;

  let current = VIP_LEVELS[0];
  for (const level of VIP_LEVELS) {
    if (wagered >= level.required) {
      current = level;
    } else {
      break;
    }
  }

  return current.level;
}

export function getLevelProgress(totalWagered = 0) {
  const wagered = Number(totalWagered) || 0;
  const currentLevel = getUserLevel(wagered);

  const currentLevelData =
    VIP_LEVELS.find((item) => item.level === currentLevel) ?? VIP_LEVELS[0];

  const nextLevelData =
    VIP_LEVELS.find((item) => item.level === currentLevel + 1) ?? null;

  if (!nextLevelData) {
    return {
      currentLevel,
      progressPercent: 100,
      prevLevelRequired: currentLevelData.required,
      nextLevelRequired: currentLevelData.required,
      remainingToNext: 0,
    };
  }

  const range = nextLevelData.required - currentLevelData.required;
  const currentInRange = Math.max(0, wagered - currentLevelData.required);
  const progressPercent = Math.min(100, (currentInRange / range) * 100);

  return {
    currentLevel,
    progressPercent,
    prevLevelRequired: currentLevelData.required,
    nextLevelRequired: nextLevelData.required,
    remainingToNext: Math.max(0, nextLevelData.required - wagered),
  };
}
