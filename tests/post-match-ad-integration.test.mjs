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

/**
 * A LIGHTENED cadence (one offer every three matches, no cooldown), used to pin
 * the counting behaviour. The shipped default is every match; the knobs must
 * keep working either way.
 */
const CADENCE = { matchesPerOffer: 3, cooldownMs: 0 };

test("the defaults offer the ad after EVERY completed match", () => {
  assert.equal(DEFAULT_POST_MATCH_AD_CADENCE.matchesPerOffer, 1);
  assert.equal(DEFAULT_POST_MATCH_AD_CADENCE.cooldownMs, 0);
});

test("by default every finished match offers the ad — once per match", () => {
  const storage = memoryStorage();
  const context = { storage, now: 0 };

  assert.equal(observeCompletedMatch("m1", context).offer, true);
  assert.equal(observeCompletedMatch("m2", context).offer, true);
  assert.equal(
    observeCompletedMatch("m2", context).offer,
    false,
    "a refresh or a duplicated event never re-offers the same match",
  );
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
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER: "x" }).matchesPerOffer, 1);
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER: "99" }).matchesPerOffer, 20);
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER: "-1" }).matchesPerOffer, 1);
  assert.equal(postMatchAdCadence({ NEXT_PUBLIC_POST_MATCH_AD_COOLDOWN_MINUTES: "9999" }).cooldownMs, 240 * 60_000);
});

test("the kill switch also works at runtime, without a rebuild", () => {
  // The server reads POST_MATCH_ADS_ENABLED per request and hands the answer to
  // the page, which passes it to the ad. Flipping it stops the surface on the
  // next request; the build-time public switch is applied on top.
  const page = read("src/app/casino/tic-tac-toe/[matchId]/page.tsx");
  const entitlement = read("src/lib/vast/entitlement.ts");
  assert.match(
    entitlement,
    /process\.env\.POST_MATCH_ADS_ENABLED/,
    "the server helper reads the flag",
  );
  assert.match(page, /await postMatchAdSurface\(\)/);
  assert.match(page, /postMatchAdsEnabled=\{ads\.enabled\}/);
  assert.match(page, /export const dynamic = "force-dynamic"/, "the flag must be read per request");

  const pilot = read(PILOT);
  assert.match(pilot, /postMatchAdsEnabled\?: boolean/);
  // The page no longer mounts the player: the shared slot resolves the surface
  // through /api/ads/post-match, which folds in the same runtime kill switch.
  assert.doesNotMatch(pilot, /PostMatchVideoAd/);

  const ad = code(read(AD_COMPONENT));
  assert.match(ad, /const active = enabled && !adFree && postMatchAdsEnabled\(\)/);
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
  assert.doesNotMatch(source, /PostMatchVideoAd/, "the shared slot owns the player");
  assert.doesNotMatch(source, /postMatchAd=\{/, "no per-page ad node");
});

test("the ad starts with the result, not on the way out", () => {
  const source = code(read(RESULT_SCREEN));

  assert.match(source, /postMatchAd = null,/, "the shared screen takes an optional node");

  // The slot mounts off `revealed`, so the tag is requested the moment the
  // result panel is on screen; no exit state is involved any more.
  const adIndex = source.indexOf(
    "{!compact && !portalSurface && !postMatchAd && revealed && (",
  );
  assert.ok(adIndex > -1, "the shared screen mounts the slot when the result reveals");
  assert.match(source, /<PostMatchAdSlot \/>/, "no exit callback is needed");
  assert.doesNotMatch(
    source,
    /adOpen|pendingExit|adAttemptedRef|handleAdSettled/,
    "the exit gate is gone: nothing parks an action behind the video",
  );

  for (const marker of ["YOU WON", "RUN IT BACK"]) {
    assert.ok(
      source.indexOf(marker) > -1 && source.indexOf(marker) < adIndex,
      `${marker} must render before the ad`,
    );
  }

  // Compact (Creator Mode) recordings never carry an ad, and a portal frame
  // never receives GRYND advertising.
  assert.match(source, /!compact && !portalSurface && !postMatchAd && revealed/);

  // The secondary href action keeps the double-click guard; the video no
  // longer gates it.
  assert.match(
    source,
    /event\.preventDefault\(\);\s*guard\("secondary", \(\) => router\.push\(secondaryAction\.href\)\)\(\)/,
    "the secondary link offers the ad too",
  );
});

test("nothing is offered before a match is definitively over", () => {
  const source = code(read(AD_COMPONENT));

  assert.match(source, /if \(!matchEnded\) return;/, "no cadence before completion");
  assert.ok(
    source.indexOf("if (!active) {") > -1 &&
      source.indexOf("if (!active) {") < source.indexOf("observeCompletedMatch(matchId)"),
    "a switched-off surface reports back and never advances the cadence",
  );
  assert.match(source, /observeCompletedMatch\(matchId\)/);
  assert.match(source, /markPostMatchAdDismissed\(matchId\)/);
  assert.match(
    source,
    /if \(!active \|\| !matchEnded \|\| !offerAllowed \|\| phase !== "ready" \|\| !media\)/,
    "the ad cannot render without completion, an allowed offer and a ready creative",
  );
});

test("reward and progression paths never depend on the ad", () => {
  const source = read(RESULT_SCREEN);
  const adIndex = source.indexOf(
    "{!compact && !portalSurface && !postMatchAd && revealed && (",
  );
  const actionsIndex = source.indexOf("{/* Actions */}");

  assert.ok(actionsIndex > -1 && actionsIndex < adIndex, "the ad follows the actions");

  const ad = code(read(AD_COMPONENT));
  for (const forbidden of ["onReward", "settle(", "credit", "payout", "coins"]) {
    assert.ok(!ad.includes(forbidden), `the ad must not participate in ${forbidden}`);
  }
});

test("only finished-match screens are wired, and nothing is global", () => {
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

  assert.deepEqual(
    offenders,
    [],
    "no page mounts the player directly: every finished match uses the shared slot",
  );
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

// ── GRYND PRO: `ad_free` covers the post-match video ──────────────────────

test("UNO's own end panel starts the video when the panel is on screen", () => {
  const uno = code(read("src/app/casino/uno/game/[gameId]/PageClient.jsx"));
  assert.match(uno, /\{endPopup && endPopupVisible && <PostMatchAdSlot \/>\}/);
  assert.match(uno, /onClick=\{requestReplay\}/);
  assert.match(uno, /onClick=\{chooseReturn\}/);
  assert.doesNotMatch(uno, /adPending|guardExit|handleAdSettled/);
});

test("a GRYND PRO member is never offered the post-match video", () => {
  // The membership answer is resolved on the server (the same authoritative
  // check the AdSense slots use) and passed in; the component refuses on it as
  // well, so a caller that forgets to fold the two flags cannot leak an ad to a
  // paying member.
  const entitlement = read("src/lib/vast/entitlement.ts");
  assert.match(entitlement, /isAdFreeViewer/);
  assert.match(entitlement, /enabled: enabled && !adFree/);

  const component = code(read(AD_COMPONENT));
  assert.match(component, /const active = enabled && !adFree && postMatchAdsEnabled\(\);/);
});

test("every surface that mounts the ad passes the server's membership answer", () => {
  for (const page of [
    "src/app/casino/tic-tac-toe/[matchId]/page.tsx",
    "src/app/casino/barrier-blitz/play-ai/page.tsx",
  ]) {
    const source = read(page);
    assert.match(source, /postMatchAdSurface\(\)/, `${page} must resolve the surface on the server`);
    assert.match(source, /postMatchAdFree=\{ads\.adFree\}/, `${page} must pass the membership answer`);
    assert.match(source, /export const dynamic = "force-dynamic"/, `${page} must not be prerendered`);
  }
});

test("practice results can offer the ad without a server match row", () => {
  const practice = read("src/app/casino/barrier-blitz/play-ai/PageClient.tsx");
  assert.doesNotMatch(practice, /PostMatchVideoAd/, "the shared slot owns the player");
  assert.doesNotMatch(practice, /postMatchAd=\{/, "no per-page ad node");
  assert.match(practice, /<PvpResultScreen/, "the result hands over to the shared screen");
});

// ── The shared slot: every game gets the surface from ONE wiring point ────

test("every result screen offers the ad through one shared slot", () => {
  const shared = read(RESULT_SCREEN);
  assert.match(shared, /import PostMatchAdSlot from "\.\.\/ads\/PostMatchAdSlot"/);
  assert.match(shared, /\{!compact && !portalSurface && !postMatchAd && revealed && \(/);
  // A game that wired its own node still wins; every other game gets the slot,
  // which mounts as soon as the result is revealed.
  assert.match(shared, /<PostMatchAdSlot \/>/);

  const slot = read("src/components/ads/PostMatchAdSlot.tsx");
  assert.match(slot, /\/api\/ads\/post-match/, "the slot asks the server");
  assert.match(
    slot,
    /params\?\.matchId \|\| params\?\.gameId/,
    "the route's match id is the cadence id",
  );
  assert.match(slot, /surface\.adFree/, "a member is refused inside the slot too");
  assert.match(slot, /practiceResultId/, "a client-only practice result mints its id");

  // The result is readable for a beat before the surface even asks.
  assert.match(slot, /export const POST_MATCH_AD_DELAY_MS = 1_500;/);
  assert.match(
    slot,
    /setTimeout\(\(\) => \{[\s\S]*?fetch\("\/api\/ads\/post-match"/,
    "the server answer is requested only after the delay",
  );
  assert.match(slot, /window\.clearTimeout\(timer\)/, "unmounting cancels the wait");
});

test("bespoke result panels mount the shared slot themselves", () => {
  // Every game whose result screen is NOT the shared `PvpResultScreen` has to
  // mount the slot directly, or that game silently loses the post-match video.
  const panels = [
    {
      file: "src/app/casino/uno/game/[gameId]/PageClient.jsx",
      gate: /\{endPopup && endPopupVisible && <PostMatchAdSlot \/>\}/,
    },
    {
      file: "src/components/solitaire-duel/SoloSolitaireGame.tsx",
      gate: /\{session\.won && !finishing && \(\s*<PostMatchAdSlot[\s\S]*?\/>/,
    },
  ];

  for (const { file, gate } of panels) {
    const source = read(file);
    assert.match(source, /import PostMatchAdSlot from/, `${file} must import the shared slot`);
    assert.match(source, gate, `${file} must render the slot only once its game is over`);
  }
});

test("solo and daily Solitaire start the video with the win panel", () => {
  const solo = code(read("src/components/solitaire-duel/SoloSolitaireGame.tsx"));

  assert.match(solo, /import PostMatchAdSlot from "\.\.\/ads\/PostMatchAdSlot"/);
  assert.match(solo, /onClick=\{restart\}/);
  assert.match(solo, /onClick=\{newSoloGame\}/);
  assert.match(solo, /\{session\.won && !finishing && \(\s*<PostMatchAdSlot/);
  assert.doesNotMatch(solo, /guardExit|runEnded|pendingExit|handleAdSettled/);
  // Daily reuses the same panel, so it inherits the wiring.
  assert.match(
    read("src/app/daily/PageClient.tsx"),
    /<SoloSolitaireGame[\s\S]*mode="daily"/,
  );
});

test("the slot's answer is server-owned and takes no client input", () => {
  const status = read("src/app/api/ads/post-match/route.ts");
  assert.match(status, /postMatchAdSurface\(\)/);
  assert.match(status, /\{ enabled, adFree \}/);
  assert.match(status, /Cache-Control/);
  // No query, no body: membership is never read from the request.
  assert.doesNotMatch(status, /searchParams|request\.json|await request/);
});

// ── GRYND PRO: `ad_free` covers EVERY post-match surface ──────────────────

test("a GRYND PRO member renders no post-match ad on any wired surface", () => {
  // 1. The entitlement is resolved server-side and folded into `enabled`, so a
  //    member never receives the player from the shared slot.
  const entitlement = read("src/lib/vast/entitlement.ts");
  assert.match(entitlement, /const adFree = await isAdFreeViewer\(\);/);
  assert.match(entitlement, /enabled: enabled && !adFree/);

  // 2. The player itself refuses on `adFree` alone — the belt to the server's
  //    braces, so a caller that only checked the kill switch cannot leak an ad.
  const component = code(read(AD_COMPONENT));
  assert.match(component, /const active = enabled && !adFree && postMatchAdsEnabled\(\);/);

  // 3. The two hand-wired surfaces pass the server's membership answer.
  for (const page of [
    "src/app/casino/tic-tac-toe/[matchId]/page.tsx",
    "src/app/casino/barrier-blitz/play-ai/page.tsx",
  ]) {
    assert.match(
      read(page),
      /postMatchAdFree=\{ads\.adFree\}/,
      `${page} must pass the membership answer`,
    );
  }

  // 4. The shared slot refuses as well, before mounting the player at all.
  const slot = read("src/components/ads/PostMatchAdSlot.tsx");
  assert.match(slot, /surface\.adFree \|\| !resolvedId/);
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

// ── The exit action can never be held hostage by the ad ────────────────────

test("an unavailable post-match ad never blocks anything, because nothing waits on it", () => {
  const result = code(read(RESULT_SCREEN));
  const slot = code(read("src/components/ads/PostMatchAdSlot.tsx"));

  // Nothing is parked behind the video any more.
  assert.doesNotMatch(result, /pendingExitRef|handleAdSettled|setAdOpen/);

  // The slot still answers exactly once, whichever path finishes first.
  assert.match(slot, /if \(settledRef\.current\) return;/);
  assert.match(slot, /onDismiss=\{\(\) => settle\(true\)\}/);
  assert.match(slot, /onNoOffer=\{\(\) => settle\(false\)\}/);
});


// ── The system back gesture is no longer an ad surface ────────────────────

test("the browser back gesture is no longer intercepted for the ad", () => {
  const result = code(read(RESULT_SCREEN));
  const uno = code(read("src/app/casino/uno/game/[gameId]/PageClient.jsx"));

  // The ad starts with the result, so back has nothing to hold: neither screen
  // cancels a pop or restores a history entry on the ad's behalf.
  assert.doesNotMatch(result, /addEventListener\("popstate"/);
  assert.doesNotMatch(result, /history\.pushState/);
  assert.doesNotMatch(uno, /addEventListener\("popstate"/);
  assert.doesNotMatch(uno, /history\.pushState/);
});
