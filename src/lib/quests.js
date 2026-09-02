import { getNeonSql } from "../db/neon";
import { addExp, expForQuest } from "./battlepass";

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    throw new Error(
      "DATABASE_URL or POSTGRES_URL is not set. Set one in your runtime environment (for example, .env.local for local development).",
    );
  }
  _sql = getNeonSql();
  return _sql;
}

// ── Period keys ───────────────────────────────────────────────────
// Daily quests key on the UTC date; weekly quests on the ISO week
// (Monday-based, matching the leaderboard's Monday reset).

export function dailyPeriodKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function weeklyPeriodKey(date = new Date()) {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // ISO 8601 week number: move to the Thursday of this week, then count
  // weeks since Jan 1 of that year. Mon=1 … Sun=7.
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ── Game normalization ────────────────────────────────────────────
// The counters pipeline receives inconsistent game strings (e.g. "Chess",
// "odds", "Dice Flush", "Crash Arena", "roulette-pvp"). Map them all to
// canonical quest game keys so "win N games of X" quests match reliably.

const GAME_ALIASES = {
  roulette: ["roulette", "Roulette", "roulette-pvp", "Roulette PvP"],
  blackjack: ["blackjack", "blackjack-pvp", "Blackjack"],
  plinko: ["plinko", "Plinko", "plinko-pvp"],
  mines: ["mines", "mines-pvp"],
  crash: ["crash", "Crash", "crash-arena", "Crash Arena"],
  keno: ["keno", "keno-pvp"],
  chess: ["chess", "Chess"],
  rps: ["rps", "rps-pvp"],
  uno: ["uno"],
  pool: ["pool", "Pool"],
  "four-in-a-row": ["four-in-a-row"],
  "hex-duel": ["hex-duel", "Hex Duel"],
  odds: ["odds"],
  dice: ["dice", "Dice Flush", "yahtzee"],
  "lane-runner": ["lane-runner"],
  "lane-rush-duel": ["lane-rush-duel"],
  "memory-grid": ["memory-grid"],
  precision: ["precision", "Precision"],
  poker: ["Poker"],
  "dots-and-boxes": ["dots-and-boxes"],
  "tower-arena": ["Tower Arena"],
};

const ALIAS_TO_KEY = new Map();
for (const [key, aliases] of Object.entries(GAME_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_KEY.set(alias.toLowerCase(), key);
}

export function normalizeGameKey(game) {
  if (!game) return null;
  return ALIAS_TO_KEY.get(String(game).toLowerCase()) || null;
}

// Popular games used for "specific game" quest generation.
export const QUEST_GAMES = [
  "roulette",
  "blackjack",
  "plinko",
  "mines",
  "crash",
  "keno",
  "chess",
  "rps",
  "uno",
  "pool",
  "four-in-a-row",
  "hex-duel",
  "odds",
  "memory-grid",
  "precision",
];

// ── Seeded RNG (mulberry32) ───────────────────────────────────────
// Same clerk + same period → identical quests all period long. Different
// players / periods → different quests.

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createQuestRng(clerkId, periodType, periodKey) {
  return mulberry32(hashSeed(`${clerkId}:${periodType}:${periodKey}`));
}

// ── Templates ─────────────────────────────────────────────────────
// Hybrid model: hand-curated templates with randomized parameters
// (target + reward) scaled by a difficulty tier. Weekly quests use the
// same templates with targets ×3 and rewards ×2.5.

const DAILY_SLOTS = 3;
const WEEKLY_SLOTS = 2;

const TEMPLATES = {
  play: {
    games: "any-or-specific",
    target: { easy: [2, 3], medium: [4, 5], hard: [6, 8] },
    reward: { easy: 40, medium: 60, hard: 80 },
  },
  win: {
    games: "any-or-specific",
    target: { easy: [1, 2], medium: [2, 3], hard: [3, 5] },
    reward: { easy: 50, medium: 75, hard: 100 },
  },
  wager: {
    games: "any",
    target: { easy: [300, 500], medium: [600, 900], hard: [1000, 1500] },
    reward: { easy: 40, medium: 60, hard: 80 },
  },
  multiplier: {
    games: "any",
    target: { easy: [2, 2], medium: [3, 4], hard: [5, 8] },
    reward: { easy: 60, medium: 90, hard: 120 },
  },
  streak: {
    games: "any",
    target: { easy: [2, 2], medium: [3, 3], hard: [4, 5] },
    reward: { easy: 60, medium: 90, hard: 120 },
  },
  diversify: {
    games: "any",
    target: { easy: [2, 2], medium: [3, 3], hard: [4, 4] },
    reward: { easy: 70, medium: 100, hard: 130 },
  },
  pvp: {
    games: "any",
    target: { easy: [1, 2], medium: [2, 3], hard: [3, 4] },
    reward: { easy: 50, medium: 75, hard: 100 },
  },
};

const TIERS = ["easy", "medium", "hard"];

// Skill-scaled tier weights: new players get easier quests, strong
// players get harder ones. Falls back to balanced weights.
async function skillTierWeights(userId) {
  try {
    const rows = await getSql()`
      SELECT total_bets, win_rate
      FROM user_stats
      WHERE user_id = ${userId}
    `;
    const r = rows[0];
    const games = Number(r?.total_bets || 0);
    const winRate = Number(r?.win_rate || 0);
    if (games < 20) return { easy: 0.6, medium: 0.3, hard: 0.1 };
    if (winRate > 55) return { easy: 0.3, medium: 0.35, hard: 0.35 };
    return { easy: 0.45, medium: 0.35, hard: 0.2 };
  } catch {
    return { easy: 0.45, medium: 0.35, hard: 0.2 };
  }
}

function pickTier(rand, weights) {
  const roll = rand();
  let acc = 0;
  for (const tier of TIERS) {
    acc += weights[tier];
    if (roll <= acc) return tier;
  }
  return "hard";
}

function pickType(rand) {
  const types = Object.keys(TEMPLATES);
  return types[Math.floor(rand() * types.length)];
}

// Roll one quest object. `recent` is a Set of signature strings from the
// player's recent periods (anti-repeat). Re-rolls up to 12 times to avoid
// repeating an identical quest the player has seen recently.
export function rollQuest({
  rand,
  tier,
  periodType,
  recent = new Set(),
  fallbackIndex = 0,
}) {
  const weekly = periodType === "weekly";
  const type = pickType(rand);
  const template = TEMPLATES[type];

  for (let attempt = 0; attempt < 12; attempt++) {
    const games = template.games;
    const gameKey =
      games === "any-or-specific" && rand() < 0.5
        ? QUEST_GAMES[Math.floor(rand() * QUEST_GAMES.length)]
        : null;
    const [min, max] = template.target[tier];
    let target = min + Math.floor(rand() * (max - min + 1));
    let reward = template.reward[tier];
    if (weekly) {
      target = Math.max(1, Math.round(target * 3));
      reward = Math.round(reward * 2.5);
    }
    const signature = `${type}|${gameKey || "any"}|${target}`;
    if (!recent.has(signature)) {
      return { questType: type, gameKey, target, reward, signature };
    }
  }
  // Fallback: accept a duplicate rather than fail generation.
  const type2 = Object.keys(TEMPLATES)[fallbackIndex % Object.keys(TEMPLATES).length];
  const template2 = TEMPLATES[type2];
  const [min2, max2] = template2.target[tier];
  let target2 = min2 + Math.floor(rand() * (max2 - min2 + 1));
  let reward2 = template2.reward[tier];
  if (weekly) {
    target2 = Math.max(1, Math.round(target2 * 3));
    reward2 = Math.round(reward2 * 2.5);
  }
  return {
    questType: type2,
    gameKey: null,
    target: target2,
    reward: reward2,
    signature: `${type2}|any|${target2}`,
  };
}

export function questSlots(periodType) {
  return periodType === "weekly" ? WEEKLY_SLOTS : DAILY_SLOTS;
}

// ── Generation + persistence ──────────────────────────────────────

async function userIdByClerkId(clerkId) {
  const rows = await getSql()`
    SELECT id FROM users WHERE clerk_id = ${clerkId} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// Build the anti-repeat signature set from the player's recent periods
// (last 7 daily periods, last 4 weekly periods).
async function recentSignatures(userId, periodType) {
  const now = new Date();
  let since;
  if (periodType === "daily") {
    since = new Date(now.getTime() - 7 * 86400000);
  } else {
    since = new Date(now.getTime() - 28 * 86400000);
  }
  const rows = await getSql()`
    SELECT quest_type, game_key, target
    FROM user_quests
    WHERE user_id = ${userId}
      AND period_type = ${periodType}
      AND created_at >= ${since.toISOString()}
  `;
  return new Set(
    rows.map(
      (r) => `${r.quest_type}|${r.game_key || "any"}|${Number(r.target)}`,
    ),
  );
}

export async function ensureQuestsForPeriod(clerkId, periodType, periodKey) {
  const userId = await userIdByClerkId(clerkId);
  if (!userId) return [];

  const existing = await getSql()`
    SELECT * FROM user_quests
    WHERE user_id = ${userId}
      AND period_type = ${periodType}
      AND period_key = ${periodKey}
    ORDER BY slot ASC
  `;
  if (existing.length) return existing;

  const rand = createQuestRng(clerkId, periodType, periodKey);
  const weights = await skillTierWeights(userId);
  const recent = await recentSignatures(userId, periodType);
  const slots = questSlots(periodType);
  const rolled = [];

  for (let slot = 0; slot < slots; slot++) {
    const tier = pickTier(rand, weights);
    const q = rollQuest({
      rand,
      tier,
      periodType,
      recent,
      fallbackIndex: slot,
    });
    rolled.push({ ...q, slot, tier });
    recent.add(q.signature);
  }

  for (const q of rolled) {
    await getSql()`
      INSERT INTO user_quests
        (user_id, period_type, period_key, slot, quest_type, game_key, target, reward)
      VALUES
        (${userId}, ${periodType}, ${periodKey}, ${q.slot}, ${q.questType}, ${q.gameKey}, ${q.target}, ${q.reward})
      ON CONFLICT (user_id, period_type, period_key, slot) DO NOTHING
    `;
  }

  return getSql()`
    SELECT * FROM user_quests
    WHERE user_id = ${userId}
      AND period_type = ${periodType}
      AND period_key = ${periodKey}
    ORDER BY slot ASC
  `;
}

// ── Progress updates (called from game settlements) ───────────────

/**
 * Increment quest progress from a settled game. Fire-and-forget from the
 * counters pipeline; never blocks the settlement response.
 */
export async function updateQuestProgress({
  clerkId,
  game = "",
  betAmount = 0,
  payout = 0,
  isPvpWin = false,
}) {
  try {
    const bet = Math.max(0, Number(betAmount) || 0);
    const win = Math.max(0, Number(payout) || 0);
    const isWin = win > bet;
    const multiplier = bet > 0 ? win / bet : 0;
    const gameKey = normalizeGameKey(game);

    const userId = await userIdByClerkId(clerkId);
    if (!userId) return;

    const dKey = dailyPeriodKey();
    const wKey = weeklyPeriodKey();

    const quests = await getSql()`
      SELECT * FROM user_quests
      WHERE user_id = ${userId}
        AND claimed = false
        AND ((period_type = 'daily' AND period_key = ${dKey})
          OR (period_type = 'weekly' AND period_key = ${wKey}))
    `;

    for (const q of quests) {
      if (Number(q.progress) >= Number(q.target)) continue; // already complete
      if (q.game_key && q.game_key !== gameKey) continue;

      let newProgress = Number(q.progress || 0);
      let meta = q.meta || {};

      switch (q.quest_type) {
        case "play":
          newProgress += 1;
          break;
        case "win":
          if (isWin) newProgress += 1;
          break;
        case "wager":
          newProgress += bet;
          break;
        case "multiplier":
          if (isWin) newProgress = Math.max(newProgress, multiplier);
          break;
        case "streak":
          newProgress = isWin ? newProgress + 1 : 0;
          break;
        case "diversify": {
          if (isWin && gameKey) {
            const won = Array.isArray(meta.wonGames) ? meta.wonGames : [];
            if (!won.includes(gameKey)) {
              won.push(gameKey);
              meta = { ...meta, wonGames: won };
              newProgress = won.length;
            }
          }
          break;
        }
        case "pvp":
          if (isPvpWin) newProgress += 1;
          break;
        default:
          continue;
      }

      newProgress = Math.min(newProgress, Number(q.target));
      await getSql()`
        UPDATE user_quests
        SET progress = ${newProgress},
            meta = ${JSON.stringify(meta)}::jsonb
        WHERE id = ${q.id}
      `;
    }
  } catch (err) {
    console.error("[quests] progress update failed:", err);
  }
}

// ── Claiming ──────────────────────────────────────────────────────

export async function claimQuest(clerkId, questId) {
  const userId = await userIdByClerkId(clerkId);
  if (!userId) throw new Error("User not found");

  const rows = await getSql()`
    SELECT * FROM user_quests
    WHERE id = ${Number(questId)} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows.length) throw new Error("Quest not found");
  const q = rows[0];
  if (q.claimed) throw new Error("Quest already claimed");
  if (Number(q.progress) < Number(q.target))
    throw new Error("Quest not completed");

  const reward = Number(q.reward || 0);
  const xp = expForQuest(reward);

  await getSql()`
    UPDATE user_quests SET claimed = true WHERE id = ${q.id}
  `;
  if (reward > 0) {
    await getSql()`
      UPDATE users SET balance = balance + ${reward} WHERE id = ${userId}
    `;
  }
  // Battlepass EXP on claim (in addition to the token reward).
  if (xp > 0) {
    await addExp(userId, xp);
  }
  return { questId: q.id, reward, xp };
}
