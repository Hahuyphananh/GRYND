import { GameplayEvent, OcrObservation } from '../types.js';
import { GameAnalyzer } from './base.js';

interface Obs {
  t: number;
  image: string;
  text: string;
  obs: OcrObservation;
}

function list(obs: OcrObservation[]): Obs[] {
  return obs
    .map((o) => ({ t: o.timestamp, image: o.image, text: o.text, obs: o }))
    .filter((o) => o.text.trim().length > 0)
    .sort((a, b) => a.t - b.t);
}

/** Single dropper that returns the first matching regex in an obs text. */
function find(o: Obs, re: RegExp): RegExpMatchArray | null {
  return o.text.match(re);
}

export const rouletteAnalyzer: GameAnalyzer = {
  game: 'roulette',
  analyze({ observations }) {
    const events: GameplayEvent[] = [];
    let lastRound = 0;
    const seen = new Set<string>();

    for (const o of list(observations)) {
      const roundM = find(o, /Round\s+(\d+)/i);
      if (roundM) {
        const n = Number(roundM[1]);
        if (n !== lastRound && n > 0) {
          const key = `rs@${o.t}`;
          if (!seen.has(key)) {
            events.push({
              type: 'roulette_round_start',
              timestamp: o.t,
              confidence: 0.7,
              importance: 'normal',
              evidence: [`t=${o.t.toFixed(2)} ${o.image}: "${roundM[0]}"`],
              sourceObservations: [o.obs],
              game: 'roulette',
              metadata: { round: n },
            });
            seen.add(key);
          }
          lastRound = n;
        }
      }

      const numM = o.text.match(/\b(?:winning\s*number|number|result)[\s\S]{0,40}?(\d{1,2})\b/i) ?? o.text.match(/^\s*(\d{1,2})\s+(?:RED|BLACK|GREEN|NOIR|ROUGE)\b/i);
      if (numM) {
        const key = `result@${o.t}`;
        if (!seen.has(key)) {
          events.push({
            type: 'roulette_result',
            timestamp: o.t,
            confidence: 0.6,
            importance: 'important',
            evidence: [`t=${o.t.toFixed(2)} ${o.image}: "${numM[0].trim()}"`],
            sourceObservations: [o.obs],
            game: 'roulette',
            metadata: { number: numM[1] },
          });
          seen.add(key);
        }
      }
    }
    return events;
  },
};

export const crashAnalyzer: GameAnalyzer = {
  game: 'crash',
  analyze({ observations }) {
    const events: GameplayEvent[] = [];
    let lastRound = 0;
    let lastMultiplier: number | null = null;
    const seen = new Set<string>();

    for (const o of list(observations)) {
      const roundM = find(o, /Round\s+(\d+)/i);
      if (roundM) {
        const n = Number(roundM[1]);
        if (n !== lastRound && n > 0) {
          const key = `cs@${o.t}`;
          if (!seen.has(key)) {
            events.push({
              type: 'crash_round_start',
              timestamp: o.t,
              confidence: 0.7,
              importance: 'normal',
              evidence: [`t=${o.t.toFixed(2)} ${o.image}: "${roundM[0]}"`],
              sourceObservations: [o.obs],
              game: 'crash',
              metadata: { round: n },
            });
            seen.add(key);
          }
          lastRound = n;
          lastMultiplier = null;
        }
      }

      const multM = o.text.match(/(\d+(?:\.\d+)?)\s*x/gi);
      if (multM && multM.length > 0) {
        const values = [...new Set(multM.map((m) => parseFloat(m.replace(/x$/i, ''))).filter((v) => Number.isFinite(v) && v > 1))];
        const multiplier = values.length > 0 ? Math.max(...values) : null;
        if (multiplier !== null) {
          if (lastMultiplier !== null && multiplier !== lastMultiplier) {
            const key = `mc@${o.t}`;
            const jump = multiplier - lastMultiplier;
            if (!seen.has(key)) {
              events.push({
                type: 'crash_multiplier_change',
                timestamp: o.t,
                confidence: 0.7,
                importance: jump >= 1.5 ? 'highlight' : 'important',
                evidence: [`t=${o.t.toFixed(2)} ${o.image}: multiplier ${lastMultiplier.toFixed(2)}x -> ${multiplier.toFixed(2)}x`],
                sourceObservations: [o.obs],
                game: 'crash',
                metadata: { from: lastMultiplier, to: multiplier, jump },
              });
              seen.add(key);
            }
          }
          lastMultiplier = multiplier;
        }
      }

      if (/\b(?:crash(?:ed)?|bust(?:ed)?)\b/i.test(o.text)) {
        const key = `ce@${o.t}`;
        if (!seen.has(key)) {
          events.push({
            type: 'crash_end',
            timestamp: o.t,
            confidence: 0.75,
            importance: 'highlight',
            evidence: [`t=${o.t.toFixed(2)} ${o.image}: OCR "${o.text.match(/\b(?:crash(?:ed)?|bust(?:ed)?)\w*/i)?.[0]}"`],
            sourceObservations: [o.obs],
            game: 'crash',
            metadata: { lastMultiplier },
          });
          seen.add(key);
        }
      }
    }
    return events;
  },
};

export const plinkoAnalyzer: GameAnalyzer = {
  game: 'plinko',
  analyze({ observations }) {
    const events: GameplayEvent[] = [];
    let lastRound = 0;
    const seen = new Set<string>();

    for (const o of list(observations)) {
      const roundM = find(o, /Round\s+(\d+)/i);
      if (roundM) {
        const n = Number(roundM[1]);
        if (n !== lastRound && n > 0) {
          const key = `ps@${o.t}`;
          if (!seen.has(key)) {
            events.push({
              type: 'plinko_round_start',
              timestamp: o.t,
              confidence: 0.7,
              importance: 'normal',
              evidence: [`t=${o.t.toFixed(2)} ${o.image}: "${roundM[0]}"`],
              sourceObservations: [o.obs],
              game: 'plinko',
              metadata: { round: n },
            });
            seen.add(key);
          }
          lastRound = n;
        }
      }

      const resM = o.text.match(/\b(?:won|lost|win|lose|payout)\b\s*[\s\S]{0,40}?(\d+(?:\.\d+)?)?\s*x?/i) ?? o.text.match(/^(\d+(?:\.\d+)?)x\b/i);
      if (resM) {
        const key = `pr@${o.t}`;
        if (!seen.has(key)) {
          events.push({
            type: 'plinko_result',
            timestamp: o.t,
            confidence: 0.55,
            importance: 'important',
            evidence: [`t=${o.t.toFixed(2)} ${o.image}: "${resM[0].trim()}"`],
            sourceObservations: [o.obs],
            game: 'plinko',
          });
          seen.add(key);
        }
      }
    }
    return events;
  },
};