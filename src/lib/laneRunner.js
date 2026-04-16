import crypto from 'crypto';

export const LANE_RUNNER_RTP = 0.96;
export const LANE_RUNNER_TILES = 24;
export const DEFAULT_LANES = 12;

export const LANE_RUNNER_DIFFICULTIES = {
  easy: { label: 'Easy', pFail: 0.04, safeTiles: 8 },
  medium: { label: 'Medium', pFail: 0.12, safeTiles: 6 },
  hard: { label: 'Hard', pFail: 0.2, safeTiles: 4 },
  extreme: { label: 'Extreme', pFail: 0.4, safeTiles: 2 },
};

export function getMultiplier(step, pFail, difficulty = 'easy') {
  if (step <= 0) return 1;

  // base growth (this is what creates “uncrossable feel”)
  const baseGrowth = 1.32;

  // difficulty amplifier (hard = faster rewards)
  const difficultyMap = {
    easy: 0.92,
    medium: 1.0,
    hard: 1.12,
    extreme: 1.28,
  };

  const diff = difficultyMap[difficulty] ?? 1;

  // exponential curve
  const raw = Math.pow(baseGrowth * diff, step);

  // soft damping so it doesn’t explode too early
  const damped = raw * (1 - pFail * step * 0.08);

  // minimum safety floor
  return Number(Math.max(1, damped).toFixed(4));
}

export function simulateOutcome(seed, nonce, step) {
  const digest = crypto
    .createHash('sha256')
    .update(`${seed}:${nonce}:${step}`)
    .digest('hex');

  const roll = parseInt(digest.slice(0, 13), 16) / 0x1fffffffffffff;
  return { roll, digest };
}

function pickSafeTiles(digest, safeTiles, totalTiles = LANE_RUNNER_TILES) {
  const selected = new Set();
  let cursor = 0;

  while (selected.size < Math.max(1, Math.min(safeTiles, totalTiles))) {
    const piece = digest.slice(cursor, cursor + 4);
    const parsed = Number.parseInt(piece || digest.slice(0, 4), 16) % totalTiles;
    selected.add(parsed);
    cursor += 4;
    if (cursor >= digest.length) cursor = 0;
  }

  return Array.from(selected).sort((a, b) => a - b);
}

export function buildProvablyFairSequence({
  serverSeed,
  clientSeed,
  nonce,
  pFail,
  safeTiles,
  tiles = LANE_RUNNER_TILES,
  lanes = DEFAULT_LANES,
}) {
  const sequence = [];
  for (let lane = 0; lane < lanes; lane += 1) {
    const { roll, digest } = simulateOutcome(`${serverSeed}:${clientSeed}`, nonce, lane);
    sequence.push({
      lane,
      roll,
      digest,
      safeTiles: pickSafeTiles(digest, safeTiles, tiles),
      isFailure: roll < pFail,
    });
  }
  return sequence;
}

export function getServerSeedHash(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

export function randomHex(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}
