// Pool Masters — AI difficulty.
//
// Two things are covered here:
//
// 1. The difficulty tiers themselves. `AI_DIFFICULTY` bundles three knobs —
//    how far the aim drifts at the contact point, how many shots get played
//    through the engine, and how low-percentage a pot the AI will take on. The
//    tests below check the tiers are ordered the way the picker claims, that a
//    plan's accepted pot always clears its own tier's bar, and that the aim
//    drift really shrinks as the tier sharpens (measured over a seeded RNG, so
//    it is the tier's number doing the work, not luck).
//
// 2. The saved preference. `aiSettings` stores the choice in localStorage and
//    falls back to `normal` for anything missing or corrupt.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  AI_DIFFICULTY,
  DEFAULT_AI_DIFFICULTY,
  describeAiPlan,
  isAiDifficulty,
  planAiShot,
  potQualityBar,
  simulateShot,
} from "../src/lib/pool/ai.ts";
import { analyzeShot, potGeometry, potPull } from "../src/lib/pool/analysis.ts";
import { evaluateRules } from "../src/lib/pool/rules.ts";
import { BALL_LAYOUT, POCKETS } from "../src/lib/pool/constants.ts";

const ball = (number, x, y, extra = {}) => {
  const layout = BALL_LAYOUT.find((b) => b.n === number);
  return {
    id: number,
    number,
    x,
    y,
    vx: 0,
    vy: 0,
    color: layout?.c ?? "#f5f5f5",
    striped: layout?.s ?? false,
    pocketed: false,
    ...extra,
  };
};
const cue = (x, y) => ball(0, x, y);
const pocketed = (n) => ball(n, 60, 460, { pocketed: true });

const TIERS = ["easy", "normal", "hard"];

/** A clean, obvious pot: the 1 sits straight in front of the top-middle pocket. */
const potTable = () => [cue(450, 400), ball(1, 450, 250)];

/**
 * A hand-rolled table generator — no Math.random, so a failure reproduces.
 * `seed` drives a small LCG; balls are kept off each other and inside the
 * rails so every table is playable.
 */
function seededTable(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const spot = (min, max) => Math.round(min + next() * (max - min));
  const balls = [cue(spot(80, 820), spot(80, 420))];
  const placed = [];
  while (placed.length < 4) {
    const x = spot(80, 820);
    const y = spot(80, 420);
    if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < 60)) continue;
    if (Math.hypot(balls[0].x - x, balls[0].y - y) < 70) continue;
    placed.push({ x, y });
  }
  const numbers = [3, 5, 9, 11];
  placed.forEach((p, i) => balls.push(ball(numbers[i], p.x, p.y)));
  balls.push(ball(8, spot(80, 820), spot(80, 420)));
  return balls;
}

// ── The tiers ───────────────────────────────────────────────────────

test("the tiers are ordered from sloppiest to sharpest", () => {
  assert.deepEqual(TIERS, ["easy", "normal", "hard"]);
  // Aim error: how badly the tier executes.
  assert.ok(AI_DIFFICULTY.easy.aimError > AI_DIFFICULTY.normal.aimError);
  assert.ok(AI_DIFFICULTY.normal.aimError > AI_DIFFICULTY.hard.aimError);
  // Caution: how carefully it chooses. A sharp tier is the careful one.
  assert.ok(AI_DIFFICULTY.easy.caution < AI_DIFFICULTY.normal.caution);
  assert.ok(AI_DIFFICULTY.normal.caution < AI_DIFFICULTY.hard.caution);
  assert.ok(AI_DIFFICULTY.easy.maxSimulations < AI_DIFFICULTY.hard.maxSimulations);
  assert.equal(DEFAULT_AI_DIFFICULTY, "normal");
  assert.ok(isAiDifficulty("hard") && !isAiDifficulty("impossible"));
});

test("a cautious tier demands a better pot than a bold one", () => {
  const easy = potQualityBar(AI_DIFFICULTY.easy.caution);
  const normal = potQualityBar(AI_DIFFICULTY.normal.caution);
  const hard = potQualityBar(AI_DIFFICULTY.hard.caution);
  assert.ok(easy < normal && normal < hard, `${easy} < ${normal} < ${hard}`);
  // The bars have to sit inside the range the shot analysis actually produces
  // (a clean line is worth 0.45-0.9), or a tier's appetite changes nothing.
  for (const bar of [easy, normal, hard]) assert.ok(bar > 0.25 && bar < 0.7);
});

test("every pot a tier plans clears that tier's own bar", () => {
  // The bar is a filter on the estimated chance, so this has to hold on any
  // table for every tier: it is the risk knob wired straight through.
  for (let seed = 1; seed <= 12; seed++) {
    const balls = seededTable(seed * 7919);
    for (const difficulty of TIERS) {
      const plan = planAiShot({
        balls,
        team: "solids",
        oppTeam: "stripes",
        openTable: false,
        difficulty,
        random: () => 0.5,
      });
      assert.ok(plan, `seed ${seed} / ${difficulty} produced no plan`);
      assert.equal(plan.difficulty, difficulty);
      if (plan.kind === "pot") {
        const bar = potQualityBar(AI_DIFFICULTY[difficulty].caution);
        assert.ok(
          plan.chance > bar,
          `seed ${seed}: ${difficulty} took a ${Math.round(plan.chance * 100)}% pot (bar ${Math.round(bar * 100)}%)`,
        );
        assert.ok(plan.target !== null && plan.pocket !== null);
      } else {
        // A safety is not aimed at a pocket, so it reports no chance.
        assert.equal(plan.chance, null);
        assert.equal(plan.pocket, null);
      }
    }
  }
});

test("risk appetite decides a marginal pot: bold takes it on, cautious passes", () => {
  // A ~50% pot — a long cut at the top-left corner. It is inside the bold
  // tiers' appetite and outside the cautious one's, so the same table has to
  // produce a pot for easy/normal and a safety for hard.
  const balls = [cue(300, 380), ball(1, 270, 220), ball(8, 60, 60)];

  const geometry = potGeometry(balls[0], balls[1], 1);
  assert.ok(geometry, "the 1 must sit on a pocket line");
  const chance = analyzeShot({
    balls,
    aim: geometry.aim,
    team: "solids",
    openTable: false,
    pull: potPull(geometry.cueDist, geometry.objDist, geometry.cutCos),
  }).pot?.chance;
  assert.ok(chance, "the line must be reported as a pot");

  const bars = {
    easy: potQualityBar(AI_DIFFICULTY.easy.caution),
    normal: potQualityBar(AI_DIFFICULTY.normal.caution),
    hard: potQualityBar(AI_DIFFICULTY.hard.caution),
  };
  assert.ok(
    chance > bars.easy && chance > bars.normal && chance <= bars.hard,
    `a ${Math.round(chance * 100)}% pot must split the tiers (bars ${Math.round(
      bars.easy * 100,
    )}/${Math.round(bars.normal * 100)}/${Math.round(bars.hard * 100)}%)`,
  );

  const plan = (difficulty) =>
    planAiShot({
      balls,
      team: "solids",
      oppTeam: "stripes",
      openTable: false,
      difficulty,
      random: () => 0.5,
    });

  const bold = plan("easy");
  assert.equal(bold.kind, "pot");
  assert.equal(bold.target, 1);
  assert.equal(bold.pocket, 1);
  assert.equal(plan("normal").kind, "pot");
  // ...and the shot the bold tier took on is a real pot, not a prayer: the
  // engine drops it and the turn is kept.
  const { balls: after, meta } = simulateShot(balls, bold.angle, bold.power);
  const ruling = evaluateRules({
    balls: after,
    turn: 2,
    myTurn: 2,
    myTeam: "solids",
    oppTeam: "stripes",
    openTable: false,
    firstContact: meta.firstContactNumber,
    railAfterContact: meta.railAfterContact,
    pocketed: [...new Set(meta.pocketedNumbers)],
    scratch: meta.cueScratch,
  });
  assert.deepEqual([...new Set(meta.pocketedNumbers)], [1]);
  assert.equal(ruling.foul, false);
  assert.equal(ruling.keepTurn, true);

  const cautious = plan("hard");
  assert.equal(cautious.kind, "safety", "the cautious tier passes on the 50% pot");
  assert.equal(cautious.chance, null);
});

test("a sharp tier's aim drifts less than a sloppy one's", () => {
  // The aim error is a fixed miss at the contact point scaled by the RNG, so
  // sweeping the RNG end to end exposes each tier's full spread.
  const sweep = [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1];
  const spread = {};
  for (const difficulty of TIERS) {
    const plans = sweep.map((value) =>
      planAiShot({
        balls: potTable(),
        team: "solids",
        oppTeam: "stripes",
        openTable: false,
        difficulty,
        random: () => value,
      }),
    );
    // Every tier must find the same obvious pot — otherwise the angles being
    // compared come from different shots and the spread means nothing.
    assert.ok(
      plans.every((p) => p && p.kind === "pot" && p.target === 1),
      `${difficulty} should pot the 1`,
    );
    const angles = plans.map((p) => p.angle);
    spread[difficulty] = Math.max(...angles) - Math.min(...angles);
  }
  assert.ok(
    spread.easy > spread.normal && spread.normal > spread.hard,
    `spreads: easy ${spread.easy} > normal ${spread.normal} > hard ${spread.hard}`,
  );
  // The spread is the tier's aim error over the shot's length — the sharpest
  // tier's must be a small fraction of a ball radius, or "hard" is a lie.
  assert.ok(spread.hard < 0.02, `hard spread ${spread.hard}`);
});

// ── The plan line shown in the shot history ────────────────────────

test("describeAiPlan names the target, the pocket and the chance", () => {
  const plan = {
    angle: 0,
    power: 100,
    kind: "pot",
    target: 3,
    pocket: 0,
    chance: 0.73,
    followUp: 0.62,
    difficulty: "normal",
  };
  const text = describeAiPlan(plan, false);
  assert.match(text, /^planned the 3 → /);
  assert.match(text, /pocket/);
  assert.match(text, /73%/);
  assert.match(text, /next shot 62%/);
  assert.ok(!text.includes("normal"), "the tier is only shown on request");
  assert.match(describeAiPlan(plan, false, { withDifficulty: true }), /normal/);

  // The 8 is named, not numbered, and a pot aimed at no pocket still reads.
  assert.match(
    describeAiPlan({ ...plan, target: 8 }, false),
    /^planned the 8-ball → /,
  );
  assert.match(
    describeAiPlan({ ...plan, pocket: null, chance: null, followUp: null }, false),
    /^planned the 3 → a pocket/,
  );
});

test("describeAiPlan reads a safety and an orientation-aware pocket name", () => {
  const safety = {
    angle: 0,
    power: 100,
    kind: "safety",
    target: 5,
    pocket: null,
    chance: null,
    followUp: null,
    difficulty: "easy",
  };
  assert.equal(describeAiPlan(safety, false), "planned a safety on the 5");
  assert.equal(
    describeAiPlan(safety, true, { withDifficulty: true }),
    "planned a safety on the 5 · easy",
  );

  const pot = { ...safety, kind: "pot", target: 2, pocket: 1, chance: 0.5 };
  // The portrait stage rotates the table, so the same pocket reads differently.
  assert.notEqual(describeAiPlan(pot, false), describeAiPlan(pot, true));
  assert.match(describeAiPlan(pot, false), new RegExp(`pocket`));
  assert.ok(Number.isInteger(pot.pocket) && pot.pocket < POCKETS.length);
});

test("a plan with a null target falls back to a generic description", () => {
  const text = describeAiPlan({
    angle: 0,
    power: 40,
    kind: "safety",
    target: null,
    pocket: null,
    chance: null,
    followUp: null,
    difficulty: "hard",
  });
  assert.match(text, /a legal ball/);
});

// ── The saved preference ───────────────────────────────────────────
//
// The store keeps its value in module scope, so each case runs in its own
// process — that is what "first load of the page" actually looks like.

const SETTINGS_URL = new URL("../src/lib/pool/aiSettings.ts", import.meta.url).href;
const STORAGE_KEY = "grynd_pool_ai_difficulty";

/**
 * Import the settings module with a stubbed `window` and run `body` against it.
 * `stored` seeds localStorage; `withWindow: false` runs with no DOM at all.
 */
function runIsolated({ stored = null, withWindow = true, body }) {
  const script = `
    const KEY = ${JSON.stringify(STORAGE_KEY)};
    const store = new Map(${JSON.stringify(stored === null ? [] : [[STORAGE_KEY, stored]])});
    ${withWindow ? `globalThis.window = {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      addEventListener: () => {},
    };` : ""}
    const m = await import(${JSON.stringify(SETTINGS_URL)});
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(result ?? null));
  `;
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

test("the saved difficulty is read back, and junk falls back to normal", () => {
  assert.equal(
    runIsolated({ stored: "hard", body: "return m.getAiDifficulty();" }),
    "hard",
  );
  assert.equal(
    runIsolated({ stored: "beatable", body: "return m.getAiDifficulty();" }),
    DEFAULT_AI_DIFFICULTY,
  );
  assert.equal(
    runIsolated({ body: "return m.getAiDifficulty();" }),
    DEFAULT_AI_DIFFICULTY,
  );
});

test("setting a difficulty persists it and notifies subscribers", () => {
  const result = runIsolated({
    body: `
      let notifications = 0;
      const unsubscribe = m.subscribeAiDifficulty(() => notifications++);
      const before = m.getAiDifficulty();
      m.setAiDifficulty("easy");
      const afterSet = m.getAiDifficulty();
      const persisted = store.get(KEY);
      m.setAiDifficulty("easy"); // same value: a no-op
      const afterRepeat = notifications;
      m.setAiDifficulty("hard");
      const afterChange = notifications;
      unsubscribe();
      m.setAiDifficulty("normal");
      return {
        before,
        afterSet,
        persisted,
        afterRepeat,
        afterChange,
        afterUnsubscribe: notifications,
        label: m.aiDifficultyLabel("easy"),
        hint: m.aiDifficultyHint("easy"),
      };
    `,
  });
  assert.equal(result.before, "normal");
  assert.equal(result.afterSet, "easy");
  assert.equal(result.persisted, "easy");
  assert.equal(result.afterRepeat, 1, "setting the same value must not notify");
  assert.equal(result.afterChange, 2);
  assert.equal(result.afterUnsubscribe, 2, "unsubscribed listeners stay quiet");
  assert.equal(result.label, "Easy");
  assert.match(result.hint, /takes shots from 35%/);
  assert.match(result.hint, /aim drifts \u00b11\.5 units/);
});

test("the store works with no storage at all", () => {
  assert.deepEqual(
    runIsolated({
      withWindow: false,
      body: `
        const initial = m.getAiDifficulty();
        m.setAiDifficulty("hard"); // must not throw without localStorage
        return { initial, after: m.getAiDifficulty() };
      `,
    }),
    { initial: DEFAULT_AI_DIFFICULTY, after: "hard" },
  );
});
