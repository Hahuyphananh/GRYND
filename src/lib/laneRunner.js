import crypto from 'crypto';

export const LANE_RUNNER_RTP = 0.96;
export const DEFAULT_LANES = 8;

export const LANE_RUNNER_DIFFICULTIES = {
  easy: {
    label: 'Easy',
    width: 4,
    badTiles: 1,
    startMultiplier: 1.28,
    endMultiplier: 7.21,
  },
  medium: {
    label: 'Medium',
    width: 3,
    badTiles: 1,
    startMultiplier: 1.44,
    endMultiplier: 18.49,
  },
  hard: {
    label: 'Hard',
    width: 2,
    badTiles: 1,
    startMultiplier: 1.92,
    endMultiplier: 184.68,
  },
};

export const LANE_RUNNER_TILES = LANE_RUNNER_DIFFICULTIES.easy.width;

export function getDifficultyMultipliers(difficulty = 'easy') {
  const config = LANE_RUNNER_DIFFICULTIES[difficulty] ?? LANE_RUNNER_DIFFICULTIES.easy;
  const multipliers = [];

  if (DEFAULT_LANES <= 1) return [Number(config.endMultiplier.toFixed(2))];

  const ratio = Math.pow(config.endMultiplier / config.startMultiplier, 1 / (DEFAULT_LANES - 1));

  for (let step = 0; step < DEFAULT_LANES; step += 1) {
    const value = config.startMultiplier * Math.pow(ratio, step);
    multipliers.push(Number(value.toFixed(2)));
  }

  multipliers[0] = Number(config.startMultiplier.toFixed(2));
  multipliers[DEFAULT_LANES - 1] = Number(config.endMultiplier.toFixed(2));

  return multipliers;
}

export function getMultiplier(step, _pFail, difficulty = 'easy') {
  if (step <= 0) return 1;
  const list = getDifficultyMultipliers(difficulty);
  const idx = Math.min(step - 1, list.length - 1);
  return Number(list[idx].toFixed(2));
}

export function simulateOutcome(seed, nonce, step) {
  const digest = crypto
    .createHash('sha256')
    .update(`${seed}:${nonce}:${step}`)
    .digest('hex');

  const roll = parseInt(digest.slice(0, 13), 16) / 0x1fffffffffffff;
  return { roll, digest };
}

function pickBadTile(digest, totalTiles) {
  return Number.parseInt(digest.slice(0, 6), 16) % totalTiles;
}

function buildSafeTiles(badTile, totalTiles) {
  return Array.from({ length: totalTiles }, (_, idx) => idx).filter((idx) => idx !== badTile);
}

export function buildProvablyFairSequence({
  serverSeed,
  clientSeed,
  nonce,
  difficulty = 'easy',
  lanes = DEFAULT_LANES,
}) {
  const config = LANE_RUNNER_DIFFICULTIES[difficulty] ?? LANE_RUNNER_DIFFICULTIES.easy;

  const sequence = [];
  for (let lane = 0; lane < lanes; lane += 1) {
    const { roll, digest } = simulateOutcome(`${serverSeed}:${clientSeed}`, nonce, lane);
    const badTile = pickBadTile(digest, config.width);
    sequence.push({
      lane,
      roll,
      digest,
      badTile,
      safeTiles: buildSafeTiles(badTile, config.width),
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
