/**
 * guest-race.test.mjs
 *
 * The guest trial: a signed-out visitor may race ONCE, immediately, against a
 * recorded human run — and is then asked to sign in.
 *
 * The rules that make that safe, and that this file pins:
 *
 *   1. a guest is never seated in the LIVE queue: the trial mints a match that
 *      is already `playing` against a ghost seat, so no `waiting` row exists for
 *      a real player to be paired into;
 *   2. a guest never settles a rating, trophy or win counter — the guest id has
 *      no `users` row at all, so settlement must skip it;
 *   3. exactly one race per guest id, enforced server-side from the store's own
 *      rows (a refresh hands back the same match, not a second one);
 *   4. a signed-in caller is refused with a pointer to the real queue;
 *   5. no opponent is ever invented: with no recording available the route says
 *      so and points at the live queue.
 *
 * Run:  node --import tsx --test tests/guest-race.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(rel, "utf8");

const store = read("src/lib/solitaire-duel/serverStore.ts");
const route = read("src/app/api/solitaire-duel/guest-race/route.ts");
const lobby = read("src/components/solitaire-duel/SolitaireLobby.tsx");

const guestRace = store.slice(
  store.indexOf("export async function createGuestGhostRace"),
  store.indexOf("export async function resolveGhostFallback"),
);

test("the trial mints a PLAYING ghost match, never a public lobby", () => {
  assert.ok(guestRace.length > 0, "createGuestGhostRace must exist");
  assert.match(guestRace, /isGhost: true/);
  assert.match(guestRace, /status: MATCH_STATUS\.PLAYING/);
  assert.match(guestRace, /player2Id: ghostPlayerIdFor\(run\.sourceMatchId\)/);
  // No waiting row is created, so the public matchmaker cannot see the trial.
  assert.doesNotMatch(guestRace, /status: MATCH_STATUS\.WAITING/);
  assert.match(guestRace, /ghostFallbackAt: null/);
  // The deal is the recording's own committed deal.
  assert.match(guestRace, /deal: run\.deal/);
  assert.match(guestRace, /serverSeed: run\.serverSeed/);
});

test("one race per guest id, and a refresh reuses it", () => {
  // The constant is declared beside the function, outside the sliced body.
  assert.match(store, /export const GUEST_TRIAL_MAX_MATCHES = 1/);
  assert.match(guestRace, /status\} IN \('waiting', 'playing'\)/);
  assert.match(guestRace, /if \(live\) return \{ match: live, reused: true \}/);
  assert.match(guestRace, /guest_trial_used/);
  assert.match(guestRace, /Your free race is used — sign in to keep racing/);
  // The limit is read from this guest's own rows, not from client state.
  assert.match(
    guestRace,
    /eq\(solitaireDuelMatches\.player1Id, userId\)\)\s*\n\s*\.limit\(GUEST_TRIAL_MAX_MATCHES\)/,
  );
});

test("a guest race can never settle a rating", () => {
  const settlement = store.slice(
    store.indexOf("async function settleSolitaireDuelMatch"),
    store.indexOf("// A GHOST duel settles into the HUMAN"),
  );
  assert.match(settlement, /if \(isGuestId\(match\.player1Id\) \|\| isGuestId\(match\.player2Id\)\) return;/);
  // And the guard sits BEFORE any rating/trophy writer in that function.
  const guardAt = settlement.indexOf("isGuestId(match.player1Id)");
  const firstWriterAt = settlement.indexOf("apply");
  assert.ok(guardAt > -1 && (firstWriterAt === -1 || guardAt < firstWriterAt));
});

test("the route uses the guest gate, not the age-verified account gate", () => {
  assert.match(route, /requirePracticePlayer\(\{ create: true \}\)/);
  assert.doesNotMatch(route, /requireAgeVerifiedUser/);
  // Signed-in callers go to the queue instead of taking the trial.
  assert.match(route, /reason: "signed_in"/);
  assert.match(route, /use the ranked queue/);
  // Identity is the session's; nothing is read from the body.
  assert.doesNotMatch(route, /await req\.json|body\?\./);
  // No recording → no invented opponent.
  assert.match(guestRace, /reason: "no_ghost"/);
});

test("the result screen asks a guest to sign up, once the race is over", () => {
  const prompt = read("src/components/solitaire-duel/GuestResultPrompt.tsx");
  const page = read("src/app/casino/solitaire-duel/[matchId]/PageClient.tsx");

  // Signed-in players never see it; guests see it only on the result screen.
  assert.match(prompt, /if \(!isLoaded \|\| isSignedIn\) return null;/);
  assert.match(page, /<GuestResultPrompt \/>/);
  const resultScreenAt = page.indexOf("<PvpResultScreen");
  const promptAt = page.indexOf("<GuestResultPrompt />");
  assert.ok(
    resultScreenAt > -1 && promptAt > resultScreenAt,
    "the prompt must live inside the result screen, not during the hand",
  );

  // It offers both halves of the ask, and both return to the ladder.
  assert.match(prompt, /data-testid="guest-result-sign-up"/);
  assert.match(prompt, /data-testid="guest-result-sign-in-link"/);
  assert.match(prompt, /\/sign-up\?redirect_url=%2Fplay%2Franked/);
  assert.match(prompt, /\/sign-in\?redirect_url=%2Fplay%2Franked/);
});

test("the lobby offers the trial and then the sign-in path", () => {
  assert.match(lobby, /\/api\/solitaire-duel\/guest-race/);
  assert.match(lobby, /onPlay: isSignedIn \? startRanked : startGuestRace/);
  assert.match(lobby, /playLabel: isSignedIn \? waitLabelFor\(waitingId\) : "Play one free race"/);
  assert.match(lobby, /canPlay: true/);
  assert.match(lobby, /data-testid="guest-trial-sign-in"/);
  // A guest never sees live tables they cannot join.
  assert.match(lobby, /lobbies: isSignedIn \? lobbies : \[\]/);
  assert.match(lobby, /guest_trial_used/);
});
