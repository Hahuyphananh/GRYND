/**
 * coin-wager-ui.test.mjs
 *
 * Coin wagering came back, so the shared PvP lobby must offer a stake picker
 * again and the four coin games must actually pass one (a lobby hard-coded to
 * stake 0 would open a free match no matter what the picker showed).
 *
 * Run:  node --import tsx --test tests/coin-wager-ui.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const LOBBY = "src/components/lobby/PvpLobby.jsx";
const lobby = fs.readFileSync(LOBBY, "utf8");

// The four games whose store escrows a coin stake.
const COIN_LOBBIES = [
  "src/app/casino/keno/PageClient.jsx",
  "src/app/casino/lane-runner/PageClient.jsx",
  "src/app/casino/memory-grid/PageClient.tsx",
  "src/app/casino/mines-pvp/PageClient.tsx",
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
  for (const file of COIN_LOBBIES) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /const stake = 0;/,
      `${file} still opens every lobby at a zero stake`,
    );
    assert.match(
      src,
      /import \{ useCoinBalance \} from "[^"]*hooks\/useCoinBalance"/,
      `${file} must read the live balance`,
    );
    assert.match(src, /const \[stake, setStake\] = useState\(/, `${file}`);
    assert.match(
      src,
      /wager=\{\{ value: stake, onChange: setStake, balance: coinBalance \}\}/,
      `${file} must pass its stake to the lobby`,
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
