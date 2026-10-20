/**
 * coin-wager-ui.test.mjs
 *
 * Every PvP game plays for coins, so each lobby must offer a stake picker and
 * actually send the chosen stake (a lobby hard-coded to stake 0 would open a
 * free match no matter what the picker showed), the Play action must be gated
 * on a legal stake, and the server entry points that OPEN a table must require
 * one.
 *
 * Run:  node --import tsx --test tests/coin-wager-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const LOBBY = "src/components/lobby/PvpLobby.jsx";
const lobby = fs.readFileSync(LOBBY, "utf8");

/**
 * Every coin lobby, with the shape it wires the stake up in. `stakeVar` is the
 * state variable that holds the selected stake (most lobbies call it `stake`;
 * Tower Arena and Odds already used `wager` for their entry).
 *
 * `sharedPicker` is true when the lobby hands the stake to the shared
 * `<PvpLobby wager={{ … }} />` control. Every coin lobby mounts that shared
 * chrome now (the per-table boards live on their own match routes).
 */
const COIN_LOBBIES = [
  { file: "src/app/casino/keno/PageClient.jsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/lane-runner/PageClient.jsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/memory-grid/PageClient.tsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/mines-pvp/PageClient.tsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/rps/PageClient.tsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/dots-and-boxes/PageClient.tsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/four-in-a-row/PageClient.tsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/uno/PageClient.jsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/tower-arena/PageClient.tsx", stakeVar: "wager", sharedPicker: true },
  { file: "src/app/casino/precision/PageClient.tsx", stakeVar: "wager", sharedPicker: true },
  { file: "src/app/casino/tic-tac-toe/PageClient.tsx", stakeVar: "stake", sharedPicker: true },
  { file: "src/app/casino/odds/PageClient.tsx", stakeVar: "stake", sharedPicker: true },
];

/** The PvP entry points that OPEN a table, and the stake field each one takes. */
const STAKE_REQUIRED_ROUTES = [
  { file: "src/app/api/rps/pvp/create/route.js", field: "betAmount" },
  { file: "src/app/api/dots-and-boxes/create-game/route.js", field: "betAmount" },
  { file: "src/app/api/four-in-a-row/create-game/route.js", field: "betAmount" },
  { file: "src/app/api/uno/join-online/route.js", field: "betAmount" },
  { file: "src/app/api/odds/create/route.ts", field: "wager" },
  { file: "src/app/api/tower-arena/create-lobby/route.ts", field: "wager" },
  { file: "src/app/api/tic-tac-toe/create-or-join/route.ts", field: "stakeAmount" },
];

/**
 * Precision's lobby create is covered by its own range instead of the shared
 * policy: it CLAMPS every request into `[MIN_WAGER, MAX_WAGER]`, so a missing
 * wager becomes the 1-coin minimum rather than a free match.
 */
test("Precision's lobby clamps every request into its legal wager range", () => {
  const route = fs.readFileSync("src/app/api/precision/create-lobby/route.ts", "utf8");
  assert.match(route, /clampWager\(/);
  assert.match(route, /Math\.max\(MIN_WAGER, Math\.min\(MAX_WAGER, Math\.floor\(value\)\)\)/);
  const constants = fs.readFileSync("src/lib/precision/constants.ts", "utf8");
  assert.match(constants, /MIN_WAGER = [1-9]/);
});

/**
 * The join entry points that take the second seat of an existing lobby, and the
 * file that must refuse a join at a stake the lobby is not open at. Tower
 * Arena checks against the lobby row inside its store (the route hands the
 * claimed stake down), so its check lives there.
 */
const STAKE_VERIFIED_JOINS = [
  { file: "src/app/api/rps/pvp/join/route.js", checkIn: "src/app/api/rps/pvp/join/route.js" },
  {
    file: "src/app/api/dots-and-boxes/join-game/route.js",
    checkIn: "src/app/api/dots-and-boxes/join-game/route.js",
  },
  {
    file: "src/app/api/four-in-a-row/join-game/route.js",
    checkIn: "src/app/api/four-in-a-row/join-game/route.js",
  },
  { file: "src/app/api/uno/join-online/route.js", checkIn: "src/app/api/uno/join-online/route.js" },
  { file: "src/app/api/odds/join/route.ts", checkIn: "src/app/api/odds/join/route.ts" },
  {
    file: "src/app/api/tower-arena/join-lobby/route.ts",
    checkIn: "src/lib/tower-arena/serverStore.ts",
  },
  {
    file: "src/app/api/precision/join-lobby/route.ts",
    checkIn: "src/lib/precision/serverStore.ts",
  },
  {
    file: "src/app/api/tic-tac-toe/create-or-join/route.ts",
    checkIn: "src/lib/tic-tac-toe/serverStore.ts",
  },
];

test("the shared lobby ships a coin stake picker with the economy cap", () => {
  assert.match(lobby, /export function CoinWagerPicker\(/);
  // The ceiling comes from the one economy source of truth.
  assert.match(lobby, /import \{ GLOBAL_MAX_BET \} from "\.\.\/\.\.\/lib\/games\/economy"/);
  assert.match(lobby, /max = GLOBAL_MAX_BET/);
  // The lobby takes an optional wager and renders the picker when present.
  assert.match(lobby, /wager = null,/);
  assert.match(lobby, /<CoinWagerPicker \{\.\.\.wager\} \/>/);
  // It flags an unaffordable stake (the server still rejects it).
  assert.match(lobby, /Not enough coins/);
  // And keeps the free-play chrome for lobbies with no wager.
  assert.match(lobby, /Free play · no tokens at stake/);
});

test("every coin lobby picks a real stake instead of a hard-coded 0", () => {
  for (const { file, stakeVar, sharedPicker } of COIN_LOBBIES) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      new RegExp(`const ${stakeVar} = 0;`),
      `${file} still opens every lobby at a zero stake`,
    );
    assert.match(
      src,
      /import \{ useCoinBalance \} from "[^"]*hooks\/useCoinBalance"/,
      `${file} must read the live balance`,
    );
    assert.match(
      src,
      new RegExp(
        `const \\[${stakeVar}, set${stakeVar[0].toUpperCase()}${stakeVar.slice(1)}\\] = useState(?:<[^>]*>)?\\(`,
      ),
      `${file} must keep the stake in state`,
    );
    if (sharedPicker) {
      assert.match(
        src,
        new RegExp(
          `wager=\\{\\{ value: ${stakeVar}, onChange: set${stakeVar[0].toUpperCase()}${stakeVar.slice(1)}, balance: coinBalance \\}\\}`,
        ),
        `${file} must pass its stake to the lobby`,
      );
    } else {
      // A custom lobby embeds the exported picker directly.
      assert.match(src, /<CoinWagerPicker[\s\S]{0,200}balance={coinBalance}/);
    }
    // …and the Play action is refused without one: PvP always plays for coins.
    // The shared lobby takes `canPlay` (some fold in their own "not busy / no
    // open lobby" terms); a lobby with its own chrome disables its button.
    assert.match(
      src,
      new RegExp(
        `(canPlay=\\{[^}]*${stakeVar} >= MIN_STAKE[^}]*\\}|disabled=\\{[^}]*${stakeVar} < MIN_STAKE[^}]*\\})`,
      ),
      `${file} must gate Play on a legal stake`,
    );
  }
});

test("every PvP entry point that opens a table requires a real stake", () => {
  for (const { file, field } of STAKE_REQUIRED_ROUTES) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /import \{[^}]*requireStake[^}]*\} from "[^"]*lib\/games\/stakes"/,
      `${file} must take its rule from the wager policy`,
    );
    assert.match(src, /requireStake\(/, `${file} must require a stake`);
    // The stake the policy returned is what gets stored — never the raw body.
    assert.doesNotMatch(
      src,
      /normalizeStake\(\s*(body\??\.(betAmount|wager)|betAmount|wager)\s*\)/,
      `${file} still normalizes a missing stake to a free match`,
    );
    assert.ok(
      src.includes(field) || src.includes(`body.${field}`),
      `${file} should still read ${field}`,
    );
  }
});

test("a joiner is held to the stake the lobby row shows", () => {
  for (const { file, checkIn } of STAKE_VERIFIED_JOINS) {
    const src = fs.readFileSync(checkIn, "utf8");
    assert.match(
      src,
      /no longer open at that stake/,
      `${checkIn} must refuse a join at a stake the lobby is not open at`,
    );
    // …and the entry point must actually carry the stake down to that check.
    const route = fs.readFileSync(file, "utf8");
    assert.match(
      route,
      /(betAmount|wager|stakeAmount)/,
      `${file} must read the stake the joiner agreed to`,
    );
  }
});

test("the balance read applies the daily grant through the same endpoint", () => {
  const hook = fs.readFileSync("src/hooks/useCoinBalance.ts", "utf8");
  assert.match(hook, /fetch\("\/api\/get-user-tokens", \{/);
  assert.match(hook, /method: "POST"/);
  // The /api mutation gate in src/proxy.ts answers 415 to a POST that does not
  // declare application/json, and this read sends no payload — so the header
  // is what lets the request reach the route at all. Without it the hook's
  // `res.ok` check failed and every balance reader (the lobby pickers and the
  // /rewards header) stayed on its "unknown" placeholder.
  assert.match(hook, /"Content-Type": "application\/json"/);
  // Signed-out / failed reads stay "unknown" (null), never 0.
  assert.match(hook, /useState<number \| null>\(null\)/);
});
