import { GameplayEvent, Importance, ImportantMoment } from './types.js';

const IMPORTANCE_WEIGHT: Record<Importance, number> = {
  normal: 1,
  important: 2,
  highlight: 3,
  major: 4,
};

const OUTCOME_TYPES = /\b(win|lose|loss|bust|blackjack|result|round_end|twenty_one)\b/i;

/**
 * Deterministic ranking of events into "important moments".
 * score = importanceWeight * (0.6 + 0.4*confidence) * outcomeFactor * proximityBonus
 */
export function scoreImportantMoments(events: GameplayEvent[], max = 12): ImportantMoment[] {
  const scored = events.map((e) => {
    const weight = IMPORTANCE_WEIGHT[e.importance] ?? 1;
    const outcomeFactor = OUTCOME_TYPES.test(e.type) ? 1.2 : 1;
    const proximityBonus = nearestStrong(events, e, 4) ? 1.05 : 1;
    const score = weight * (0.6 + 0.4 * e.confidence) * outcomeFactor * proximityBonus;
    return {
      eventType: e.type,
      timestamp: e.timestamp,
      importance: e.importance,
      score,
      confidence: e.confidence,
      reason: eventReason(e) + (proximityBonus > 1 ? ' (near another highlight)' : ''),
    };
  });

  return scored.sort((a, b) => b.score - a.score || a.timestamp - b.timestamp).slice(0, max);
}

function eventReason(e: GameplayEvent): string {
  if (e.evidence.length === 0) return e.type;
  const first = e.evidence[0];
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

function nearestStrong(events: GameplayEvent[], e: GameplayEvent, withinSec: number): boolean {
  for (const other of events) {
    if (other === e) continue;
    if (other.importance === 'highlight' || other.importance === 'major') {
      if (Math.abs(other.timestamp - e.timestamp) <= withinSec) return true;
    }
  }
  return false;
}