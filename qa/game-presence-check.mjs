// qa/game-presence-check.mjs
//
// Static audit of the per-game ACTIVE PLAYER presence wiring (the casino
// lobby's "N playing" badge). It answers, from the real repository, the two
// questions the feature lives or dies on:
//
//   1. Is EVERY game the lobby ships actually wired to the heartbeat?
//   2. Does each one stop counting when its session is over — and does a
//      spectator on a live match stay uncounted?
//
// It reads the same sources the app does (the lobby's game array, the game
// catalog, every <CreatorModeHost> mount, every direct useActiveGamePresence /
// useRecordPlayedGame call), so a new game added to the lobby — or a game that
// forgets `autoStop` — fails here instead of silently mis-reporting players.
//
// Nothing is written and no network/database is touched.
//
// Run: node qa/game-presence-check.mjs      (npm run verify:game-presence)

import fs from "node:fs";
import path from "node:path";

import { GAME_CATALOG } from "../src/lib/gameTags.js";
import { GAME_LABEL_TO_GAME_ID, PRESENCE_GAME_IDS } from "../src/lib/gamePresence.js";

const ROOT = process.cwd();
const LOBBY = "src/app/casino/PageClient.jsx";
const CLIENT = "src/lib/gamePresenceClient.js";
const HEARTBEAT_ENDPOINT = "/api/presence/active-game";

const failures = [];
const fail = (message) => failures.push(message);

const source = (relPath) =>
  fs.readFileSync(path.join(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");

/**
 * Source with comments removed, so a JSDoc usage example
 * (`<CreatorModeHost gameLabel="...">`) is never mistaken for a real wiring.
 * The `//` pass may eat a `//` inside a string (a URL) — harmless here: no prop
 * this script reads ever holds one.
 */
const code = (relPath) =>
  source(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(tsx|jsx|ts|js)$/.test(entry.name) && rel !== CLIENT) out.push(rel);
  }
  return out;
}

/** The JSX/props text of the element starting at `start`, brace-balanced so a
 *  `=>` inside a prop expression cannot end the tag early. */
function readElement(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** The argument list of the call starting at `start` (same balance rule). */
function readCall(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

const oneLine = (value, max = 58) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** A prop's raw value from a JSX opening element: `name={...}` (balanced, so
 *  a nested `}` or `=>` can't truncate it) or `name="..."`. */
function prop(element, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=`).exec(element);
  if (!match) return null;
  const rest = element.slice(match.index + match[0].length).trimStart();
  if (rest.startsWith("{")) {
    let depth = 0;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "{") depth += 1;
      else if (rest[i] === "}") {
        depth -= 1;
        if (depth === 0) return rest.slice(0, i + 1);
      }
    }
    return null;
  }
  const quoted = rest.match(/^"([^"]*)"/);
  return quoted ? quoted[1] : null;
}

// ── Inventory ────────────────────────────────────────────────────────────

const lobby = source(LOBBY);
/**
 * The lobby card for a canonical game id: its `playsKey` (the label its game
 * page reports) plus whether the id itself is a card key at all. Read by
 * proximity rather than by one fixed `leaderboardKey → playsKey` regex, so the
 * two keys can sit in either order and any comment between them is harmless.
 */
function lobbyCardFor(id) {
  const at = lobby.indexOf(`leaderboardKey: "${id}"`);
  if (at === -1) return null;
  const window = lobby.slice(Math.max(0, at - 300), at + 300);
  return { playsKey: window.match(/playsKey: "([^"]+)"/)?.[1] ?? null };
}

const files = [...walk("src/app"), ...walk("src/components"), ...walk("src/hooks")];

const hostMounts = [];
const directCalls = [];
const recordLabels = new Map(); // file → [labels]

for (const file of files) {
  // Comments are stripped: a doc block that names <CreatorModeHost> or
  // useActiveGamePresence(...) is documentation, not a wiring.
  const text = code(file);

  for (const match of text.matchAll(/<\s*CreatorModeHost\b/g)) {
    const element = readElement(text, match.index);
    hostMounts.push({
      file,
      label: prop(element, "gameLabel"),
      autoStart: prop(element, "autoStart"),
      autoStop: prop(element, "autoStop"),
      presenceEnabled: prop(element, "presenceEnabled"),
    });
  }

  for (const match of text.matchAll(/useActiveGamePresence\s*\(/g)) {
    const call = readCall(text, match.index + match[0].length - 1);
    const [, label, active] = call.match(/^\((?:[\s\S]*?)?"([^"]+)",([\s\S]*)$/) ?? [];
    // The shared host passes a variable (gameLabel); only a literal label is a
    // per-game integration.
    if (!label) continue;
    directCalls.push({
      file,
      label,
      active: oneLine(active?.split(/,\s*\{|\)\s*;?\s*$/)[0]),
      terminal: call.match(/terminal:\s*([^,}\n]+)/)?.[1] ?? null,
    });
  }

  for (const match of text.matchAll(/useRecordPlayedGame\s*\(\s*"([^"]+)"/g)) {
    recordLabels.set(file, [...(recordLabels.get(file) ?? []), match[1]]);
  }
}

/** Every surface that reports presence for a canonical id. */
function sourcesFor(gameId) {
  const labels = Object.entries(GAME_LABEL_TO_GAME_ID)
    .filter(([, id]) => id === gameId)
    .map(([label]) => label);

  const hosts = hostMounts.filter((mount) => mount.label && labels.includes(mount.label));
  const directs = directCalls.filter((call) => call.label && labels.includes(call.label));
  return { labels, hosts, directs };
}

// ── 1. Every lobby game is wired ─────────────────────────────────────────

console.log("GRYND — active players per game (lobby \"N playing\" badge)\n");
console.log("game                 lobby card        source   start / stop signal");
console.log("─".repeat(112));

for (const game of GAME_CATALOG) {
  const { hosts, directs } = sourcesFor(game.id);
  const card = lobbyCardFor(game.id);

  if (!card) fail(`${game.id}: no lobby card in ${LOBBY}`);
  else if (!card.playsKey) fail(`${game.id}: lobby card has no playsKey`);
  if (hosts.length === 0 && directs.length === 0) {
    fail(`${game.id}: NOT WIRED — no CreatorModeHost mount and no useActiveGamePresence call`);
  }

  const rows = [
    ...hosts.map((mount) => ({
      file: mount.file,
      mode: "host",
      start: oneLine(mount.autoStart),
      stop: oneLine(mount.autoStop),
    })),
    ...directs.map((call) => ({
      file: call.file,
      mode: "hook",
      start: oneLine(call.active),
      stop: call.terminal ? `terminal: ${oneLine(call.terminal)}` : "unmount / window",
    })),
  ];

  for (const [index, row] of rows.entries()) {
    const file = row.file.replace(/^src\/app\/casino\//, "").replace(/^src\//, "");
    console.log(
      [
        (index === 0 ? game.id : "").padEnd(20),
        (index === 0 ? (card?.playsKey ?? "?") : "").padEnd(17),
        row.mode.padEnd(8),
        `${file}  ${row.start} → ${row.stop}`,
      ].join("")
    );
  }
}

// ── 2. A host mount must expose BOTH lifecycle edges ─────────────────────

function checkHost(mount) {
  if (!mount.label) return; // defaults to "game" → presence is gated off
  if (mount.label === "precision-test") return; // dev harness, deliberately unmapped
  if (!mount.autoStart) fail(`${mount.file} (${mount.label}): no autoStart → could never be counted`);
  if (!mount.autoStop) fail(`${mount.file} (${mount.label}): no autoStop → could be counted forever`);
}
hostMounts.forEach(checkHost);

// ── 3. The 4 pages without the host must wire the same hook ──────────────

for (const [file, labels] of recordLabels) {
  const wired = directCalls.filter((call) => call.file === file).map((call) => call.label);
  for (const label of labels) {
    if (!wired.includes(label)) {
      fail(`${file}: records a play for "${label}" but never calls useActiveGamePresence("${label}")`);
    }
  }
}

// ── 4. One implementation, and only for real games ───────────────────────

const otherSenders = files.filter((file) => code(file).includes(HEARTBEAT_ENDPOINT));
if (otherSenders.length > 0) {
  fail(
    `only ${CLIENT} may call ${HEARTBEAT_ENDPOINT}; also found: ${otherSenders.join(", ")}`
  );
}

const unknownLabels = [...hostMounts, ...directCalls]
  .map((entry) => entry.label)
  .filter((label) => label && !(label in GAME_LABEL_TO_GAME_ID) && label !== "precision-test");
if (unknownLabels.length > 0) {
  fail(`labels with no canonical game id: ${[...new Set(unknownLabels)].join(", ")}`);
}

for (const id of PRESENCE_GAME_IDS) {
  if (!lobbyCardFor(id)) {
    fail(`${id}: not a lobby leaderboardKey, so the badge can't be rendered`);
  }
}

// ── 5. Spectators ────────────────────────────────────────────────────────

const spectatorGuards = hostMounts.filter((mount) => mount.presenceEnabled);
console.log(
  `\nspectator / opt-out gates (${spectatorGuards.length}): ` +
    spectatorGuards.map((mount) => `${mount.label} → ${oneLine(mount.presenceEnabled, 40)}`).join(" | ")
);

// ── Result ───────────────────────────────────────────────────────────────

console.log(
  `\n${GAME_CATALOG.length} lobby games · ${hostMounts.length} host mounts · ` +
    `${directCalls.length} direct hook calls · ${spectatorGuards.length} gates`
);

if (failures.length > 0) {
  console.error(`\n✖ ${failures.length} problem(s):`);
  for (const message of failures) console.error(`  • ${message}`);
  process.exit(1);
}

console.log("\n✔ every lobby game is wired, every session has an end, spectators are excluded.");
