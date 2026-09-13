import { GameId, GameplayEvent, OcrObservation } from '../types.js';

export interface GameAnalyzer {
  readonly game: GameId;
  readonly analyze: (input: { observations: OcrObservation[] }) => GameplayEvent[];
}

export function obsText(observations: OcrObservation[]): string {
  return observations.map((o) => o.text).join('\n');
}

export function nonTemplateLines(lines: Array<{ text: string }>): Array<{ text: string }> {
  return lines.filter((l) => !/[{}]/.test(l.text) && l.text.trim().length > 0);
}