const GRID_CELLS = 25;
const HOUSE_EDGE = 0.99;

function nCr(n, r) {
  if (r < 0 || r > n) return 0;
  if (r === 0 || r === n) return 1;
  const k = Math.min(r, n - r);
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (n - k + i)) / i;
  }
  return result;
}

export function getMinesMultiplier(mines, revealed) {
  const mineCount = Number(mines);
  const revealCount = Number(revealed);
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount > 24) return 1;
  const safeCells = GRID_CELLS - mineCount;
  if (
    !Number.isInteger(revealCount) ||
    revealCount < 0 ||
    revealCount > safeCells
  )
    return 1;
  if (revealCount === 0) return 1;

  const fair = nCr(GRID_CELLS, revealCount) / nCr(safeCells, revealCount);
  return Number((fair * HOUSE_EDGE).toFixed(2));
}

export function buildMinesMultiplierTable() {
  const table = {};
  for (let mines = 1; mines <= 24; mines += 1) {
    const safeCells = GRID_CELLS - mines;
    table[mines] = {};
    for (let revealed = 1; revealed <= safeCells; revealed += 1) {
      table[mines][revealed] = getMinesMultiplier(mines, revealed);
    }
  }
  return table;
}
