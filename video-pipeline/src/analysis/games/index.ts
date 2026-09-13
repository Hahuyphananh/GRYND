import { GameplayEvent } from '../types.js';
import { GameAnalyzer } from './base.js';
import { blackjackAnalyzer } from './blackjack.js';
import { crashAnalyzer, plinkoAnalyzer, rouletteAnalyzer } from './simple.js';

/** Honest fallback: no fabricated gameplay events when the game is unknown. */
export const genericAnalyzer: GameAnalyzer = {
  game: 'unknown',
  analyze() {
    return [] as GameplayEvent[];
  },
};

const REGISTRY: Record<string, GameAnalyzer> = {
  blackjack: blackjackAnalyzer,
  roulette: rouletteAnalyzer,
  crash: crashAnalyzer,
  plinko: plinkoAnalyzer,
  unknown: genericAnalyzer,
};

export function analyzerFor(game: string): GameAnalyzer {
  return REGISTRY[game] ?? genericAnalyzer;
}