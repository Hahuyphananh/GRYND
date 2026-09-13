import { GameId, GameIdentification, OcrObservation } from './types.js';

interface Signal {
  game: GameId;
  weight: number;
  reason: string;
}

const FILENAME_SIGNALS: Array<{ re: RegExp; game: GameId; weight: number }> = [
  { re: /blackjack|\bbj\b|\b21\b/i, game: 'blackjack', weight: 0.9 },
  { re: /roulette|rouge|noir/i, game: 'roulette', weight: 0.9 },
  { re: /crash/i, game: 'crash', weight: 0.9 },
  { re: /plinko|plink/i, game: 'plinko', weight: 0.9 },
];

const TEXT_SIGNALS: Array<{ re: RegExp; game: GameId; weight: number; reason: string }> = [
  { re: /\bblackjack\b|\bbj\b|\b21\b|\bpoints?\b|\bpts\b|\bhit\b|\bstand\b|\bdealer\b|\bsplit\b|\bdouble down\b/i, game: 'blackjack', weight: 0.55, reason: 'blackjack UI vocabulary' },
  { re: /\broulette\b|\brouge\b|\bnoir\b|\bzero\b|\b00\b|\bodd\b|\beven\b/i, game: 'roulette', weight: 0.55, reason: 'roulette UI vocabulary' },
  { re: /\bcrash\b|\bmultiplier\b|\bcash\s*out\b|\bbet\s*amount\b/i, game: 'crash', weight: 0.55, reason: 'crash UI vocabulary' },
  { re: /\bplinko\b|\bplink\b/i, game: 'plinko', weight: 0.55, reason: 'plinko UI vocabulary' },
];

/** A few require the game name itself to be present to call it. */
const NAME_ONLY: Array<{ re: RegExp; game: GameId }> = [
  { re: /\bblackjack\b/i, game: 'blackjack' },
  { re: /\broulette\b/i, game: 'roulette' },
  { re: /\bcrash\b/i, game: 'crash' },
  { re: /\bplinko\b/i, game: 'plinko' },
];

const MIN_CONFIDENCE = 0.35;

/**
 * Deterministic, conservative game identification using filename, OCR text and
 * GRYND UI vocabulary. Returns `unknown` when evidence is weak rather than
 * risking a confident misclassification.
 */
export function identifyGame(input: { filename: string; observations: OcrObservation[] }): GameIdentification {
  const signals: Signal[] = [];

  for (const s of FILENAME_SIGNALS) {
    if (s.re.test(input.filename)) signals.push({ game: s.game, weight: s.weight, reason: `filename matches ${s.game}` });
  }

  const text = input.observations
    .map((o) => o.text)
    .join(' ')
    .slice(0, 20_000);

  for (const s of TEXT_SIGNALS) {
    if (s.re.test(text)) signals.push({ game: s.game, weight: s.weight, reason: s.reason });
  }

  // A literal game name anywhere is the strongest single signal.
  for (const s of NAME_ONLY) {
    if (s.re.test(text)) signals.push({ game: s.game, weight: 0.9, reason: `OCR contains the literal name "${s.game}"` });
  }

  const totals = new Map<GameId, { score: number; reasons: string[] }>();
  for (const s of signals) {
    const entry = totals.get(s.game) ?? { score: 0, reasons: [] as string[] };
    entry.score += s.weight;
    // cap the sum so many small signals can't exceed a strong literal name
    entry.score = Math.min(entry.score, 1);
    if (entry.reasons.length < 5 && !entry.reasons.includes(s.reason)) entry.reasons.push(s.reason);
    totals.set(s.game, entry);
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1].score - a[1].score);
  const top = ranked[0];

  if (!top || top[1].score < MIN_CONFIDENCE) {
    return { game: 'unknown', confidence: 0, reasons: ['insufficient evidence to identify the game'] };
  }

  const game = top[0];
  const reasons = top[1].reasons;
  return { game, confidence: Math.min(0.99, top[1].score), reasons };
}