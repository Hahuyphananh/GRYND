/**
 * friend-challenge.test.mjs
 *
 * Friend Challenge links: one URL that seats a friend opposite you on the same
 * deterministic deal, without either player entering the public queue.
 *
 * The rules that make the feature SAFE, and that this file pins:
 *
 *   1. a code is a capability, not an id — it is generated from node crypto over
 *      an unambiguous alphabet, and it locates a WAITING private lobby only;
 *   2. the private lobby is an ordinary seeded match (same deal, two boards), so
 *      the fairness invariants of ranked Solitaire are untouched;
 *   3. the public matchmaker must never see it — every queue query filters
 *      `invite_code IS NULL` — and it must never ghost-fallback;
 *   4. identity is the session's, never the URL's or the body's;
 *   5. the landing page is noindex: a private table is not a search result.
 *
 * Run:  node --import tsx --test tests/friend-challenge.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FRIEND_CHALLENGE_ALPHABET,
  FRIEND_CHALLENGE_CODE_LENGTH,
  FRIEND_CHALLENGE_TTL_MS,
  DISCORD_COMPOSER_URL,
  friendChallengeMessage,
  friendChallengePath,
  friendChallengeShareLinks,
  friendChallengeUrl,
  isFriendChallengeCode,
  normalizeFriendChallengeCode,
} from "../src/lib/solitaire-duel/friendChallenge.ts";
import { generateFriendChallengeCode } from "../src/lib/solitaire-duel/inviteCodes.ts";
import { readProfileSource } from "./helpers/profile-source.mjs";

const read = (rel) => readFileSync(rel, "utf8");
/** Strip comment lines: prose may NAME a thing the code must not do. */
const codeOnly = (src) =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

test("codes are generated from crypto over an unambiguous alphabet", () => {
  const source = codeOnly(read("src/lib/solitaire-duel/inviteCodes.ts"));
  assert.match(source, /from "node:crypto"/);
  assert.match(source, /randomBytes/);
  assert.doesNotMatch(source, /Math\.random/);
  // 256 % alphabet.length === 0 is what makes the modulo unbiased.
  assert.equal(256 % FRIEND_CHALLENGE_ALPHABET.length, 0);

  for (const ambiguous of ["I", "O", "0", "1"]) {
    assert.ok(
      !FRIEND_CHALLENGE_ALPHABET.includes(ambiguous),
      `the alphabet must not contain ${ambiguous}`,
    );
  }

  const codes = Array.from({ length: 200 }, () => generateFriendChallengeCode());
  for (const code of codes) {
    assert.equal(code.length, FRIEND_CHALLENGE_CODE_LENGTH);
    assert.equal(normalizeFriendChallengeCode(code), code);
  }
  assert.ok(new Set(codes).size > 190, "codes must not repeat in practice");
});

test("a pasted code or URL normalises to the canonical form", () => {
  const canonical = "ABCD2345";
  assert.equal(normalizeFriendChallengeCode(canonical), canonical);
  assert.equal(normalizeFriendChallengeCode("abcd2345"), canonical);
  assert.equal(normalizeFriendChallengeCode("  abcd-2345 "), canonical);
  assert.equal(normalizeFriendChallengeCode("abcd 2345"), canonical);
  assert.equal(
    normalizeFriendChallengeCode("https://www.grynd.dedyn.io/duel/abcd2345"),
    canonical,
  );
  assert.equal(normalizeFriendChallengeCode("https://x.test/duel/ABCD2345?utm=1"), canonical);

  // Ambiguous characters and wrong lengths are refused rather than guessed.
  assert.equal(normalizeFriendChallengeCode("ABCD234"), null);
  assert.equal(normalizeFriendChallengeCode("ABCD23456"), null);
  assert.equal(normalizeFriendChallengeCode("ABCD234O"), null); // letter O
  assert.equal(normalizeFriendChallengeCode(""), null);
  assert.equal(normalizeFriendChallengeCode(null), null);
  assert.equal(normalizeFriendChallengeCode(42), null);
  assert.equal(isFriendChallengeCode("abcd-2345"), true);
  assert.equal(isFriendChallengeCode("nope"), false);
});

test("the shared URL is built in one place and is absolute", () => {
  assert.equal(friendChallengePath("abcd2345"), "/duel/ABCD2345");
  assert.equal(friendChallengePath("nope"), null);

  const url = friendChallengeUrl("abcd2345");
  assert.ok(url && url.endsWith("/duel/ABCD2345"), `unexpected url: ${url}`);
  assert.match(url, /^https?:\/\//);

  const message = friendChallengeMessage("abcd2345");
  assert.ok(message && message.includes(url));
  assert.equal(friendChallengeMessage("nope"), null);

  // Seven days, and the landing page promises exactly that.
  assert.equal(FRIEND_CHALLENGE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test("WhatsApp is prefilled; Discord copies the message then opens", () => {
  const links = friendChallengeShareLinks("abcd2345");
  assert.ok(links, "a valid code must produce share links");

  assert.ok(links.whatsapp.startsWith("https://wa.me/?text="));
  const prefilled = decodeURIComponent(links.whatsapp.slice("https://wa.me/?text=".length));
  // The message, not just the raw path: an unexplained link reads as spam.
  assert.equal(prefilled, friendChallengeMessage("abcd2345"));
  assert.ok(prefilled.includes(friendChallengeUrl("abcd2345")));

  // Discord has no prefilled-message URL; the composer is the honest target.
  assert.equal(links.discord, DISCORD_COMPOSER_URL);
  assert.equal(links.discord, "https://discord.com/channels/@me");

  assert.equal(friendChallengeShareLinks("nope"), null);

  const panel = read("src/components/solitaire-duel/FriendChallengePanel.tsx");
  assert.match(panel, /data-testid="friend-challenge-whatsapp"/);
  assert.match(panel, /friendChallengeShareLinks\(challenge\.code\)\?\.whatsapp/);
  assert.match(panel, /data-testid="friend-challenge-discord"/);
  // The Discord button copies the prefilled message before opening Discord.
  assert.match(panel, /writeText\(message\)/);
  assert.match(panel, /window\.open\(DISCORD_COMPOSER_URL/);
  // Copy and native Share stay exactly where they were.
  assert.match(panel, /data-testid="friend-challenge-copy"/);
  assert.match(panel, /data-testid="friend-challenge-share"/);
});

test("the private lobby is addressable but invisible to public matchmaking", () => {
  const store = read("src/lib/solitaire-duel/serverStore.ts");

  // EVERY public-queue read excludes invite rows.
  const openMatches = store.slice(
    store.indexOf("export async function listOpenMatches"),
    store.indexOf("/** The caller's own still-waiting lobby"),
  );
  assert.match(openMatches, /isNull\(solitaireDuelMatches\.inviteCode\)/);

  const myWaiting = store.slice(
    store.indexOf("export async function listMyWaitingMatch"),
    store.indexOf("/**\n * Match the caller into an open lobby"),
  );
  assert.match(myWaiting, /isNull\(solitaireDuelMatches\.inviteCode\)/);

  const createOrJoin = store.slice(
    store.indexOf("export async function createOrJoin"),
    store.indexOf("async function createWaitingMatch"),
  );
  assert.match(createOrJoin, /isNull\(solitaireDuelMatches\.inviteCode\)/);

  // A private invite takes no ghost fallback: it waits for its friend, or dies.
  assert.match(store, /ghostFallbackAt: invite \? null : new Date\(nowMs \+ GHOST_FALLBACK_MS\)/);
  assert.match(store, /inviteCode: invite\?\.code \?\? null/);
});

test("seating a friend is one locked claim, idempotent for both seats", () => {
  const store = read("src/lib/solitaire-duel/serverStore.ts");
  const join = store.slice(
    store.indexOf("export async function joinFriendChallenge"),
    store.indexOf("export async function findFriendChallenge"),
  );

  assert.match(join, /pg_advisory_xact_lock/);
  assert.match(join, /\.for\("update"\)/);
  assert.match(join, /row\.player1Id === userId/);
  assert.match(join, /row\.player2Id === userId/);
  assert.match(join, /joinExistingMatch\(tx, row\.id, userId, nowMs, 0\)/);
  // The free-play rule: a friend challenge can never become a staked match.
  assert.doesNotMatch(join, /stakeAmount\s*[:=]\s*(?!0)/);

  // The preview exposes status only — never a match id, board or seed.
  const preview = store.slice(
    store.indexOf("export async function findFriendChallenge"),
    store.indexOf("export async function createSolitaireMatchForPair"),
  );
  assert.match(preview, /status: "open"/);
  assert.match(preview, /status: "started"/);
  assert.match(preview, /status: "expired"/);
  assert.match(preview, /status: "unknown"/);
  assert.doesNotMatch(preview, /dealSeed|serverSeed|p1State|p2State/);
});

test("the migration and schema agree, and the migration is journaled", () => {
  const sql = read("src/db/migrations/0259_solitaire_duel_friend_links.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS invite_code VARCHAR\(12\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMP/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS solitaire_duel_matches_invite_code_idx/);
  assert.match(sql, /WHERE invite_code IS NOT NULL/);

  const schema = read("src/db/schema.ts");
  assert.match(schema, /inviteCode: varchar\("invite_code", \{ length: 12 \}\)/);
  assert.match(schema, /inviteExpiresAt: timestamp\("invite_expires_at"\)/);

  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const entry = journal.entries.find((row) => row.tag === "0259_solitaire_duel_friend_links");
  assert.ok(entry, "0259 must be in the drizzle journal or it never runs");
  // Indexed from its own position, so a later migration does not break this.
  assert.equal(
    entry.idx,
    journal.entries.findIndex((row) => row.tag === "0259_solitaire_duel_friend_links"),
  );
});

test("the API trusts the session, not the code or the body", () => {
  const create = read("src/app/api/solitaire-duel/invite/route.ts");
  assert.match(create, /requireAgeVerifiedUser\(\)/);
  assert.match(create, /createFriendChallenge\(\{ userId \}\)/);
  assert.match(create, /friendChallengeUrl\(code\)/);

  const join = read("src/app/api/solitaire-duel/invite/[code]/route.ts");
  // Both verbs read the claimant from the session.
  assert.match(join, /requireAgeVerifiedUser\(\)/);
  assert.match(join, /joinFriendChallenge\(\{ userId, code \}\)/);
  assert.match(join, /normalizeFriendChallengeCode\(resolved\.code\)/);
  // No route may accept an identity (or a stake) from the request.
  assert.doesNotMatch(
    codeOnly(create + join),
    /body\?\.userId|body\.userId|stake/,
  );

  // The landing page is a private table, never an indexed page.
  const page = read("src/app/duel/[code]/page.tsx");
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /normalizeFriendChallengeCode\(resolved\.code\)/);

  const client = read("src/app/duel/[code]/PageClient.tsx");
  assert.match(client, /\/api\/solitaire-duel\/invite\//);
  assert.match(client, /redirect_url/);
});

test("the lobby shows the creator when the friend accepts", () => {
  // The lobby snapshot carries the caller's OWN live challenge, so a reload
  // does not lose the link and the creator can see the acceptance.
  const lobby = read("src/app/api/solitaire-duel/lobby/route.ts");
  assert.match(lobby, /getMyFriendChallenge/);
  assert.match(lobby, /myChallenge/);
  assert.match(lobby, /A lobby read must never fail because an invite read did/);

  const store = read("src/lib/solitaire-duel/serverStore.ts");
  const helper = store.slice(
    store.indexOf("export async function getMyFriendChallenge"),
    store.indexOf("export async function createOrJoin"),
  );
  // Owner-scoped: a code alone can never read somebody else's challenge.
  assert.match(helper, /eq\(solitaireDuelMatches\.player1Id, userId\)/);
  assert.match(helper, /inviteCode\} IS NOT NULL/);
  assert.match(helper, /opponentJoined: Boolean\(row\.player2Id\)/);
  // Status only — no board, no seed, no opponent identity in the projection.
  assert.doesNotMatch(helper, /p1State|p2State|dealSeed|serverSeed/);

  // The panel watches the match snapshot and reacts to the server's `playing`.
  const panel = read("src/components/solitaire-duel/FriendChallengePanel.tsx");
  assert.match(panel, /\/api\/solitaire-duel\/match\/\$\{challenge\.matchId\}/);
  assert.match(panel, /status === "playing"/);
  assert.match(panel, /data-testid="friend-challenge-accepted"/);
  assert.match(panel, /data-testid="friend-challenge-waiting"/);
  assert.match(panel, /data-testid="friend-challenge-enter"/);
  // It rehydrates from the lobby, so a reload keeps the same link.
  assert.match(panel, /fetch\("\/api\/solitaire-duel\/lobby"/);
  assert.match(panel, /friendChallengeUrl\(mine\.code\)/);
  // No invented opponent: acceptance is the server's word, not a local guess.
  assert.doesNotMatch(panel, /opponent(Name|name)\s*[:=]\s*"/);
});

test("the lobby offers the link, and never auto-creates one", () => {
  const panel = read("src/components/solitaire-duel/FriendChallengePanel.tsx");
  assert.match(panel, /fetch\("\/api\/solitaire-duel\/invite", \{/);
  assert.match(panel, /method: "POST"/);
  assert.match(panel, /navigator\.clipboard\.writeText\(challenge\.url\)/);
  assert.match(panel, /nav\.share/);
  // The URL is displayed exactly as the server built it.
  assert.match(panel, /value=\{challenge\.url\}/);

  const lobby = read("src/components/solitaire-duel/SolitaireLobby.tsx");
  assert.match(lobby, /import RankedFriendsPanel from "\.\/RankedFriendsPanel"/);
  assert.match(lobby, /<RankedFriendsPanel \/>/);

  // The ranked friends tab searches the caller's real friends and creates a
  // private Solitaire Duel room through the server-authoritative room API.
  const ranked = read("src/components/solitaire-duel/RankedFriendsPanel.tsx");
  assert.match(ranked, /fetch\("\/api\/friends\/list"/);
  assert.match(ranked, /fetch\("\/api\/rooms\/challenge"/);
  assert.match(ranked, /gameKey: "solitaire-duel"/);
  assert.match(ranked, /data-testid="ranked-friend-search"/);
  assert.match(ranked, /data-testid="ranked-challenge-created"/);
});

test("the profile no longer hosts its own challenge button", () => {
  const profile = readProfileSource();
  assert.doesNotMatch(profile, /ChallengeFriendDialog|challengeTarget|challengeStatus/);
  assert.doesNotMatch(profile, /profile\.friends\.challenge/);
});
