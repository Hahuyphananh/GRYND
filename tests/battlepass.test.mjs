import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LEVEL,
  TROPHIES_PER_LEVEL,
  expForNextLevel,
  expForWager,
  expToReachLevel,
  getBattlepassProgress,
  getBattlepassProgressFromTrophies,
  getLevelFromTrophies,
  getLevelFromXp,
  trophiesToReachLevel,
} from "../src/lib/battlepass.js";
import { TITLE_MILESTONES } from "../src/lib/titles.ts";
import {
  BATTLEPASS_REWARDS,
  COSMETIC_REWARD_TYPES,
  RESERVED_LEVELS,
  REWARD_RARITIES,
  REWARD_TYPES,
  rewardsForLevel,
} from "../src/lib/battlepassRewards.js";

test("cumulative XP to reach each level follows the 150 + 10*(n-1) ramp", () => {
  assert.equal(expToReachLevel(1), 0);
  assert.equal(expToReachLevel(2), 150);
  assert.equal(expToReachLevel(3), 310); // 150 + 160
  assert.equal(expToReachLevel(4), 480); // + 170
  assert.equal(expToReachLevel(5), 660); // + 180
  assert.equal(expToReachLevel(10), 1710);
  assert.equal(expToReachLevel(20), 4560);
  assert.equal(expToReachLevel(50), 19110);
  assert.equal(expToReachLevel(100), 63360);
});

test("XP to advance from level N is 150 + 10*(N-1), 0 at the cap", () => {
  assert.equal(expForNextLevel(1), 150);
  assert.equal(expForNextLevel(2), 160);
  assert.equal(expForNextLevel(50), 640);
  assert.equal(expForNextLevel(MAX_LEVEL), 0);
});

test("getLevelFromXp inverts the cumulative curve", () => {
  assert.equal(getLevelFromXp(0), 1);
  assert.equal(getLevelFromXp(149), 1);
  assert.equal(getLevelFromXp(150), 2);
  assert.equal(getLevelFromXp(309), 2);
  assert.equal(getLevelFromXp(310), 3);
  assert.equal(getLevelFromXp(63359), 99);
  assert.equal(getLevelFromXp(63360), 100);
  assert.equal(getLevelFromXp(1e9), 100); // clamped at the cap
  assert.equal(getLevelFromXp(-50), 1); // negatives clamped
});

test("getBattlepassProgress returns level + progress within the level", () => {
  const p = getBattlepassProgress(155); // level 2, range 150-310 (160 XP wide)
  assert.equal(p.level, 2);
  assert.equal(p.currentLevelXp, 150);
  assert.equal(p.nextLevelXp, 310);
  assert.equal(p.progressPercent, 3); // 5 / 160
  assert.equal(p.remainingToNext, 155);
  assert.equal(p.maxLevel, MAX_LEVEL);

  const half = getBattlepassProgress(230); // 80 / 160
  assert.equal(half.level, 2);
  assert.equal(half.progressPercent, 50);

  const fresh = getBattlepassProgress(0);
  assert.equal(fresh.level, 1);
  assert.equal(fresh.progressPercent, 0);

  const maxed = getBattlepassProgress(63360);
  assert.equal(maxed.level, 100);
  assert.equal(maxed.remainingToNext, 0);
});

test("closed-form level matches brute-force level across the whole track", () => {
  // The SQL in leaderboardCounters uses the same closed form, so this
  // guards the DB-level computation against the pure-JS one.
  const sqlLevel = (xp) =>
    Math.min(100, Math.max(1, Math.floor((Math.sqrt(21025 + 20 * xp) - 135) / 10)));
  for (let xp = 0; xp <= 70000; xp += 7) {
    assert.equal(getLevelFromXp(xp), sqlLevel(xp), `level mismatch at xp=${xp}`);
  }
});

test("expForWager grants 1 XP per 10 staked, 0 for fun-mode bets", () => {
  assert.equal(expForWager(0), 0);
  assert.equal(expForWager(9), 0);
  assert.equal(expForWager(10), 1);
  assert.equal(expForWager(100), 10);
  assert.equal(expForWager(250), 25);
  assert.equal(expForWager("1000"), 100);
});

test("reward track covers exactly levels 1-100 with reserved slots", () => {
  assert.equal(BATTLEPASS_REWARDS.length, 100);
  for (let i = 0; i < 100; i++) {
    assert.equal(BATTLEPASS_REWARDS[i].level, i + 1);
  }
  // Every reserved level is empty, every other level has a reward.
  const reserved = new Set(RESERVED_LEVELS);
  for (let level = 1; level <= 100; level++) {
    const rewards = rewardsForLevel(level);
    if (reserved.has(level)) {
      assert.equal(rewards.length, 0, `reserved level ${level} should be empty`);
    } else {
      assert.ok(rewards.length >= 1, `level ${level} should have a reward`);
    }
  }
});

test("rewards contain valid fields and only official owned types", () => {
  // Derive the allowed set from the catalogs the page/track actually use, so
  // adding a supported type (e.g. tokens or a cosmetic kind) can never drift
  // out of sync with a hand-maintained list here.
  const supportedTypes = new Set([
    ...Object.keys(REWARD_TYPES),
    ...COSMETIC_REWARD_TYPES,
  ]);
  for (const entry of BATTLEPASS_REWARDS) {
    for (const reward of entry.rewards) {
      assert.ok(supportedTypes.has(reward.type), `unsupported reward at level ${entry.level}`);
      assert.ok(reward.type && reward.name && reward.desc, `incomplete reward at level ${entry.level}`);
      assert.ok(reward.rarity, `missing rarity at level ${entry.level}`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(REWARD_RARITIES, reward.rarity),
        `unknown rarity "${reward.rarity}" at level ${entry.level} (add it to REWARD_RARITIES)`,
      );
      if (reward.type === "emote") {
        assert.equal(typeof reward.key, "string");
        assert.match(reward.key, /^[a-z0-9][a-z0-9._-]{0,119}$/);
        assert.ok(!reward.key.includes("/"), "emote reward must use a stable key");
      }
      if (reward.type === "shield") {
        assert.equal(typeof reward.value, "number", `shield reward at level ${entry.level} must have a numeric value`);
      }
    }
  }
});

test("the track carries no token rewards and no currency-typed entries", () => {
  // GRYND has no token currency, so the Battle Pass must not pay one and
  // must not reference a `tokens` reward type at all.
  assert.ok(!Object.keys(REWARD_TYPES).includes("tokens"));
  for (const entry of BATTLEPASS_REWARDS) {
    for (const reward of entry.rewards) {
      assert.notEqual(reward.type, "tokens", `token reward at level ${entry.level}`);
      assert.ok(
        !("tokens" in reward),
        `reward at level ${entry.level} carries a token amount`,
      );
    }
  }
});

test("every level 1-100 carries a reward or is an explicit reserved slot", () => {
  const reserved = new Set(RESERVED_LEVELS);
  for (let level = 1; level <= 100; level++) {
    const rewards = rewardsForLevel(level);
    if (reserved.has(level)) {
      assert.equal(
        rewards.length,
        0,
        `reserved level ${level} must stay empty until a replacement reward is specified`,
      );
    } else {
      assert.ok(
        rewards.length >= 1,
        `level ${level} has no reward and is not listed in RESERVED_LEVELS`,
      );
    }
  }
});

test("battlepass_xp is retired — the track carries no flat XP rewards", () => {
  // The Battle Pass is driven by trophies now, so the flat XP filler rewards
  // were removed. Their levels are reserved until replacement rewards are
  // specified (RESERVED_LEVELS), never silently dropped.
  const offenders = [];
  for (const entry of BATTLEPASS_REWARDS) {
    for (const reward of entry.rewards) {
      if (reward.type === "battlepass_xp") offenders.push(entry.level);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `battlepass_xp rewards must be removed; found at levels: ${offenders.join(", ")}`,
  );
  assert.ok(
    RESERVED_LEVELS.length > 0,
    "the retired XP levels must be tracked in RESERVED_LEVELS",
  );
});

test("trophiesToReachLevel: 100 trophies per level, 9,900 at level 100", () => {
  assert.equal(TROPHIES_PER_LEVEL, 100);
  assert.equal(trophiesToReachLevel(1), 0);
  assert.equal(trophiesToReachLevel(2), 100);
  assert.equal(trophiesToReachLevel(100), 9900);
});

test("getLevelFromTrophies: level 1 at 0 trophies, level 100 at 10,000", () => {
  assert.equal(getLevelFromTrophies(0), 1);
  assert.equal(getLevelFromTrophies(99), 1);
  assert.equal(getLevelFromTrophies(100), 2);
  assert.equal(getLevelFromTrophies(9999), 100);
  assert.equal(getLevelFromTrophies(10000), 100);
  assert.equal(getLevelFromTrophies(999999), 100); // clamped at the cap
});

test("getBattlepassProgressFromTrophies reports progress within the level", () => {
  const p = getBattlepassProgressFromTrophies(250);
  assert.equal(p.level, 3);
  assert.equal(p.currentLevelTrophies, 200);
  assert.equal(p.nextLevelTrophies, 300);
  assert.equal(p.progressPercent, 50);
  assert.equal(p.remainingToNext, 50);
});

test("level 3 contains the Daily Streak Shield reward", () => {
  assert.deepEqual(rewardsForLevel(3), [
    {
      type: "shield",
      name: "Daily Streak Shield",
      desc: "Protects your daily streak for one missed day",
      value: 1,
      rarity: "Common",
      premium: true,
    },
  ]);
});

test("rewards escalate: no high rarity in early levels, capstone at 100", () => {
  // Common → Overlord, with the item-shop rarities (Rare / Epic) the cosmetic
  // rewards reuse slotted in. Must stay monotonic with REWARD_RARITIES.
  const rank = {
    Common: 0,
    Bronze: 1,
    Silver: 2,
    Rare: 3,
    Gold: 4,
    Elite: 5,
    Epic: 6,
    Mythic: 7,
    Overlord: 8,
  };
  for (const entry of BATTLEPASS_REWARDS) {
    for (const reward of entry.rewards) {
      if (entry.level <= 20) {
        assert.ok(rank[reward.rarity] <= 1, `level ${entry.level} too rare (${reward.rarity})`);
      } else if (entry.level <= 50) {
        assert.ok(rank[reward.rarity] <= 3, `level ${entry.level} too rare (${reward.rarity})`);
      }
    }
  }
  const top = rewardsForLevel(100);
  assert.ok(top.some((r) => r.type === "title" && r.rarity === "Overlord"));
  assert.ok(top.some((r) => r.type === "color" && r.name.includes("Golden")));
  // No Mythic/Overlord rewards before level 80.
  for (const entry of BATTLEPASS_REWARDS) {
    if (entry.level < 80) {
      for (const reward of entry.rewards) {
        assert.ok(
          reward.rarity !== "Mythic" && reward.rarity !== "Overlord",
          `premium rarity at level ${entry.level}`,
        );
      }
    }
  }
});

test("title milestones fit the 100-level track and keep the ladder", () => {
  assert.ok(TITLE_MILESTONES.length > 30);
  assert.equal(TITLE_MILESTONES[0].level, 1);
  assert.equal(TITLE_MILESTONES[TITLE_MILESTONES.length - 1].title, "GRYND OVERLORD");
  assert.equal(TITLE_MILESTONES[TITLE_MILESTONES.length - 1].level, 100);
  for (const m of TITLE_MILESTONES) {
    assert.ok(m.level >= 1 && m.level <= MAX_LEVEL, `milestone ${m.title} out of range`);
  }
  // Levels are strictly increasing.
  for (let i = 1; i < TITLE_MILESTONES.length; i++) {
    assert.ok(
      TITLE_MILESTONES[i].level > TITLE_MILESTONES[i - 1].level,
      `milestones out of order at index ${i}`,
    );
  }
});
