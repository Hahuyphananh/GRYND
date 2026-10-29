// tests/post-match-ad-integration.test.mjs
//
// Contract guard for the post-match ad cadence and its single pilot wiring.
//
// The policy half exercises the real module against injected storage: one offer
// per THREE completed matches, never consecutive, one count per match id (so a
// refresh/duplicate event cannot advance it), a cooldown after an offer, and a
// dismissal that resets the cycle.
//
// The wiring half proves the surface is reachable only from a definitively
// finished PvP match, sits below every result/reward/action, and is absent from
// settlement, Elo, escrow, rules and matchmaking code.
//
// Run: npm run test:post-match-ads

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative, sep } from "node:path";

import {
  DEFAULT_POST_MATCH_AD_CADENCE,
  POST_MATCH_AD_STATE_KEY,
  markPostMatchAdDismissed,
  observeCompletedMatch,
  postMatchAdCadence,
} from "../src/lib/vast/frequency.ts";
import { postMatchAdsEnabled } from "../src/lib/vast/config.ts";

const read = (path) => fs.readFileSync(path, "utf8");

/** Assertions test CODE, not the prose that explains it. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PILOT = "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx";
const RESULT_SCREEN = "src/components/result/PvpResultScreen.jsx";
const AD_COMPONENT = "src/components/ads/PostMatchVideoAd.tsx";

/** In-memory stand-in for localStorage. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    raw: () => map.get(POST_MATCH_AD_STATE_KEY) ?? null,
  };
}

/** Three matches per offer, no cooldown — the timing gets its own tests. */
const CADENCE = { matchesPerOffer: 3, cooldownMs: 0 };

test("the defaults are one offer every three completed matches", () => {
  assert.equal(DEFAULT_POST_MATCH_AD_CADENCE.matchesPerOffer, 3);
  assert.equal(DEFAULT_POST_MATCH_AD_CADENCE.cooldownMs, 5 * 60_000);
});

test("the first two completed matches never offer; the third does", () => {
  const storage = memoryStorage();
  const context = { storage, cadence: CADENCE, now: 0 };

  assert.equal(observeCompletedMatch("m1", context).offer, false);
  assert.equal(observeCompletedMatch("m2", context).offer, false);
  assert.equal(observeCompletedMatch("m3", context).offer, true);
});

test("an offer resets the cycle, so ads are never consecutive", () => {
  const storage = memoryStorage();
  const context = { storage, cadence: CADENCE, now: 0 };

  const offers = [];
  for (let index = 1; index <= 9; index += 1) {
    offers.push(observeCompletedMatch(`m${index}`, context).offer);
  }

  assert.deepEqual(
    offers,
    [false, false, true, false, false, true, false, false, true],
    "ads land on the 3rd, 6th and 9th match — never back to back",
  );
});

test("a refresh of the same result is not a new completed match", () => {
  const storage = memoryStorage();
  const context = { storage, cadence: CADENCE, now: 0 };

  observeCompletedMatch("m1", context);
  observeCompletedMatch("m2", context);

  // Refresh: the same match id arrives again, twice, from a remount.
  assert.equal(observeCompletedMatch("m2", context).offer, false);
  assert.equal(observeCompletedMatch("m2", context).offer, false);

  // The cycle did not advance, so m3 is still the third match.
  assert.equal(observeCompletedMatch("m3", context).offer, true);

  // Refreshing the offering result must not re-offer it.
  assert.equal(observeCompletedMatch("m3", context).offer, false);
});

test("a duplicated realtime event counts once", () => {
  const storage = memoryStorage();
  const context = { storage, cadence: CADENCE, now: 0 };

  observeCompletedMatch("m1", context);
  observeCompletedMatch("m1", context);
  observeCompletedMatch("m2", context);
  observeCompletedMatch("m2", context);

  assert.equal(
    observeCompletedMatch("m3", context).offer,
    true,
    "two matches counted twice each must not satisfy a three-match cycle",
  );

  const state = JSON.parse(storage.raw());
  assert.deepEqual(state.matches, ["m1", "m2", "m3"]);
});

test("the cooldown holds back an otherwise-due offer", () => {
  const storage = memoryStorage();
  const cadence = { matchesPerOffer: 3, cooldownMs: 5 * 60_000 };

  assert.equal(observeCompletedMatch("m1", { storage, cadence, now: 0 }).offer, false);
  assert.equal(observeCompletedMatch("m2", { storage, cadence, now: 0 }).offer, false);
  assert.equal(observeCompletedMatch("m3", { storage, cadence, now: 0 }).offer, true);

  // Three more matches immediately: the cycle is due but the cooldown is not.
  observeCompletedMatch("m4", { storage, cadence, now: 1_000 });
  observeCompletedMatch("m5", { storage, cadence, now: 1_000 });
  assert.equal(
    observeCompletedMatch("m6", { storage, cadence, now: 1_000 }).offer,
    false,
    "a second ad inside the cooldown window is refused",
  );

  // Once the window passes, the very next completed match takes the offer —
  // a blocked offer is deferred, not skipped.
  assert.equal(
    observeCompletedMatch("m7", { storage, cadence, now: 5 * 60_000 }).offer,
    true,
  );
});

test("dismissing an ad resets the cycle and blocks an immediate ad", () => {
  const storage = memoryStorage();
  const cadence = { matchesPerOffer: 3, cooldownMs: 5 * 60_000 };

  observeCompletedMatch("m1", { storage, cadence, now: 0 });
  observeCompletedMatch("m2", { storage, cadence, now: 0 });
  assert.equal(observeCompletedMatch("m3", { storage, cadence, now: 0 }).offer, true);

  // The player closes the card immediately.
  markPostMatchAdDismissed("m3", { storage, cadence, now: 1_000 });

  // Three more matches right away: the reset cycle is due, but the dismissal
  // cooldown blocks it.
  observeCompletedMatch("m4", { storage, cadence, now: 2_000 });
  observeCompletedMatch("m5", { storage, cadence, now: 2_000 });
  assert.equal(
    observeCompletedMatch("m6", { storage, cadence, now: 2_000 }).offer,
    false,
    "closing an ad must not immediately trigger another",
  );

  // After the cooldown, the next completed match may offer again.
  assert.equal(
    observeCompletedMatch("m7", { storage, cadence, now: 6 * 60_000 }).offer,
    true,
  );
});

test("dismissal is idempotent", () => {
  const storage = memoryStorage();
  const context = { storage, cadence: CADENCE, now: 100 };

  observeCompletedMatch("m1", context);
  markPostMatchAdDismissed("m1", context);
  markPostMatchAdDismissed("m1", { ...context, now: 200 });

  const state = JSON.parse(storage.raw());
  assert.equal(state.progress, 0);
  assert.equal(state.lastDismissedAt, 100, "a repeat dismissal does not extend the block");
  assert.deepEqual(state.matches, ["m1"]);
});

test("a blank match id, or no storage, never offers and records nothing", () => {
  const storage = memoryStorage();
  const context = { storage, cadence: CADENCE, now: 0 };

  for (const id of ["", "   ", null, undefined]) {
    assert.equal(observeCompletedMatch(id, context).offer, false);
  }
  assert.equal(storage.raw(), null, "a blank id must not write state");

  assert.equal(
    observeCompletedMatch("m1", { storage: null, cadence: CADENCE, now: 0 }).offer,
    false,
    "without storage the cadence fails closed",
  );
});

test("a corrupt record cannot break the result screen", () => {
  const storage = memoryStorage();
  storage.setItem(POST_MATCH_AD_STATE_KEY, "{not json");

  assert.doesNotThrow(() => observeCompletedMatch("m1", { storage, cadence: CADENCE, now: 0 }));
  assert.equal(
    observeCompletedMatch("m1", { storage, cadence: CADENCE, now: 0 }).offer,
    false,
  );
});

test("the counted-match record stays bounded", () => {
  const storage = memoryStorage();
  const cadence = { matchesPerOffer: 1, cooldownMs: 0 };

  for (let index = 0; index < 40; index += 1) {
    observeCompletedMatch(`m${index}`, { storage, cadence, now: index });
  }

  const state = JSON.parse(storage.raw());
  assert.ok(state.matches.length <= 20, "the match list is capped");
});

test("the cadence is configurable, clamped and defaulted", () => {
  assert.deepEqual(postMatchAdCadence({}), DEFAULT_POST_MATCH_AD_CADENCE);
  assert.deepEqual(
    postMatchAdCadence({
      NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER: "2",
      NEXT_PUBLIC_POST_MATCH_AD_COOLDOWN_MINUTES: "10",
    }),
    { matchesPerOffer: 2, cooldownMs: 10 * 60_000 },
  );

  // Nonsense falls back; out-of-range clamps rather than disabling the limit.
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER: "x" }).matchesPerOffer, 3);
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER: "99" }).matchesPerOffer, 20);
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER: "-1" }).matchesPerOffer, 1);
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_COOLDOWN_MINUTES: "9999" }).cooldownMs, 240 * 60_000);
});

test("the kill switch also works at runtime, without a rebuild", () => {
  // The server reads POST_MATCH_ADS_ENABLED per request and hands the answer to
  // the page, which passes it to the ad. Flipping it stops the surface on the
  // next request; the build-time public switch is applied on top.
  const page = read("src/app/casino/tic-tac-toe/[matchId]/page.tsx");
  assert.match(page, /process\.env\.POST_MATCH_ADS_ENABLED/);
  assert.match(page, /<PageClient postMatchAdsEnabled=\{postMatchAdsEnabledOnServer\(\)\} \/>/);
  assert.match(page, /export const dynamic = "force-dynamic"/, "the flag must be read per request");

  const pilot = read(PILOT);
  assert.match(pilot, /postMatchAdsEnabled\?: boolean/);
  assert.match(pilot, /enabled=\{postMatchAdsEnabled\}/, "the page's flag reaches the ad");

  const ad = code(read(AD_COMPONENT));
  assert.match(ad, /const active = enabled && postMatchAdsEnabled\(\)/);
});

test("the kill switch disables every post-match ad", () => {
  const saved = {
    master: process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED,
    provider: process.env.NEXT_PUBLIC_HILLTOPS_ENABLED,
  };

  try {
    delete process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED;
    delete process.env.NEXT_PUBLIC_HILLTOPS_ENABLED;
    assert.equal(postMatchAdsEnabled(), true, "advertising is on by default");

    process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED = "false";
    assert.equal(postMatchAdsEnabled(), false, "the master switch disables the surface");

    process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED = "true";
    process.env.NEXT_PUBLIC_HILLTOPS_ENABLED = "false";
    assert.equal(postMatchAdsEnabled(), false, "the provider switch disables it too");

    process.env.NEXT_PUBLIC_HILLTOPS_ENABLED = "true";
    process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED = "TRUE ";
    assert.equal(postMatchAdsEnabled(), true, "the flag is read case-insensitively");
  } finally {
    if (saved.master === undefined) delete process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED;
    else process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED = saved.master;
    if (saved.provider === undefined) delete process.env.NEXT_PUBLIC_HILLTOPS_ENABLED;
    else process.env.NEXT_PUBLIC_HILLTOPS_ENABLED = saved.provider;
  }
});

// ── Wiring ─────────────────────────────────────────────────────────────────

test("the pilot's completion signal is the server's own match status", () => {
  const source = read(PILOT);

  assert.match(
    source,
    /const finished = match\?\.status === "finished";/,
    "completion must come from the authoritative snapshot, never a local guess",
  );
  assert.match(source, /<PvpResultScreen\s+open=\{finished\}/);
  assert.match(source, /postMatchAd=\{/);
  assert.match(source, /match\.isAi \? null : \(/, "AI/practice matches are excluded");
  assert.match(source, /matchEnded=\{finished\}/);
  assert.match(source, /matchId=\{String\(matchId \?\? ""\)\}/);
});

test("the ad lives below every result, reward and action", () => {
  const source = read(RESULT_SCREEN);

  assert.match(source, /postMatchAd = null,/, "the shared screen takes an optional node");

  const adIndex = source.indexOf("{postMatchAd && !compact && (");
  assert.ok(adIndex > -1, "the shared screen renders the node");

  for (const marker of ["YOU WON", "RUN IT BACK", "Match Details"]) {
    assert.ok(
      source.indexOf(marker) > -1 && source.indexOf(marker) < adIndex,
      `${marker} must render before the ad`,
    );
  }

  assert.match(
    source,
    /\{postMatchAd && !compact && \(/,
    "compact (Creator Mode) recordings never carry an ad",
  );
});

test("nothing is offered before a match is definitively over", () => {
  const source = code(read(AD_COMPONENT));

  assert.match(source, /if \(!active \|\| !matchEnded\) return;/, "no cadence before completion");
  assert.match(source, /observeCompletedMatch\(matchId\)/);
  assert.match(source, /markPostMatchAdDismissed\(matchId\)/);
  assert.match(
    source,
    /if \(!active \|\| !matchEnded \|\| !offerAllowed \|\| phase === "dismissed"\)/,
    "the card cannot render without completion and an allowed offer",
  );
});

test("reward and progression paths never depend on the ad", () => {
  const source = read(RESULT_SCREEN);
  const adIndex = source.indexOf("{postMatchAd && !compact && (");
  const actionsIndex = source.indexOf("{/* Actions */}");

  assert.ok(actionsIndex > -1 && actionsIndex < adIndex, "the ad follows the actions");

  const ad = code(read(AD_COMPONENT));
  for (const forbidden of ["onReward", "settle(", "credit", "payout", "coins"]) {
    assert.ok(!ad.includes(forbidden), `the ad must not participate in ${forbidden}`);
  }
});

test("exactly one game is wired — the pilot — and nothing is global", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|tsx?)$/.test(entry.name) && /PostMatchVideoAd/.test(read(full))) {
        offenders.push(relative(process.cwd(), full).split(sep).join("/"));
      }
    }
  };
  walk("src/app");

  assert.deepEqual(offenders, [PILOT], "only the Tic-Tac-Toe pilot may mount the ad");
  assert.ok(
    !/PostMatchVideoAd/.test(read("src/app/layout.tsx")),
    "nothing advertising may be mounted globally",
  );
});

test("no lobby, browsing page or matchmaking surface mounts the ad", () => {
  for (const forbidden of [
    "src/app/casino/page.jsx",
    "src/app/casino/tic-tac-toe/page.tsx",
    "src/app/page.jsx",
    "src/app/profil/page.jsx",
  ]) {
    assert.ok(
      !/PostMatchVideoAd/.test(read(forbidden)),
      `${forbidden} is a browsing/lobby surface and must stay ad-free`,
    );
  }
});

test("settlement, Elo, escrow, rules and matchmaking code are untouched", () => {
  for (const file of [
    "src/lib/tic-tac-toe/serverStore.ts",
    "src/lib/tic-tac-toe/rules.ts",
    "src/lib/tic-tac-toe/ai.ts",
    "src/lib/tic-tac-toe/ui.ts",
    "src/lib/tic-tac-toe/types.ts",
  ]) {
    const source = read(file);
    assert.ok(
      !/PostMatchVideoAd|postMatchAd|observeCompletedMatch|vast/i.test(source),
      `${file} must stay ad-agnostic`,
    );
  }
});
