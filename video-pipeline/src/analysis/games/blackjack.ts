import { GameplayEvent, Importance, OcrObservation } from '../types.js';
import { GameAnalyzer } from './base.js';

interface ObsText {
  t: number;
  image: string;
  text: string;
  obs: OcrObservation;
}

const PLAYER_MARKER = /Player\s+\d+\s*\(You\)/i;
const SCORE_AFTER_MARKER = /Player\s+\d+\s*\(You\)[\s\S]{0,80}?(\d{1,2})\s*(?:pts|points)?/i;

function playerScoreOf(o: ObsText): number | null {
  if (!PLAYER_MARKER.test(o.text)) return null;
  const m = o.text.match(SCORE_AFTER_MARKER);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return v;
}

function dealerScoreOf(o: ObsText): number | null {
  const m = o.text.match(/Dealer[\s\S]{0,80}?(\d{1,2})\s*(?:pts|points)?/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function roundOf(o: ObsText): number | null {
  const lines = o.obs.lines;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (!t || /[{}]/.test(t)) continue;
    // Header is often split across two OCR lines: "ROUND" / "1 /3".
    if (/^round$/i.test(t) && i + 1 < lines.length) {
      const m = /^(\d+)\s*\/\s*\d+$/.exec(lines[i + 1].text.trim());
      if (m) return Number(m[1]);
    }
    // Merged form "ROUND 1 /3".
    const m2 = /^round\s+(\d+)\s*\/\s*\d+\s*$/i.exec(t);
    if (m2) return Number(m2[1]);
  }
  return null;
}

/** Lines that are UI chrome, static help content or history templates — never game outcomes. */
function isOutcomeCandidate(line: string): boolean {
  if (!line || /[{}]/.test(line)) return false;
  if (/closest to|going over|= bust|how to play|rules|: bust/i.test(line)) return false;
  if (/pvp|free ai match|play now|golden|tournament|leaderboard/i.test(line)) return false;
  // Persistent round-history template rows like "Round won", "Round 2: lost".
  if (/^round(?:\s+\d+)?\s*[:.]?\s*(?:won|lost|result|win)\s*$/i.test(line)) return false;
  return true;
}

function resultOf(o: ObsText): { kind: 'win' | 'loss' | 'push' | 'bust' | 'blackjack'; raw: string } | null {
  const bustLine = o.obs.lines.find((l) => isOutcomeCandidate(l.text.trim()) && /\bbust(?:ed)?\b/i.test(l.text));
  if (bustLine) return { kind: 'bust', raw: bustLine.text.trim() };

  for (const line of o.obs.lines) {
    const t = line.text.trim();
    if (!isOutcomeCandidate(t)) continue;
    // Round-outcome announcements, e.g. "GRYND A1 wins round 1".
    const winRound = /^(.{2,40}?)\s+wins?\s+round\s+\d+$/i.exec(t);
    if (winRound) {
      const winner = winRound[1].trim();
      return /you|player 1|\(you\)/i.test(winner) ? { kind: 'win', raw: t } : { kind: 'loss', raw: t };
    }
    const loseRound = /^(.{2,40}?)\s+loses?\s+round\s+\d+$/i.exec(t);
    if (loseRound) {
      const loser = loseRound[1].trim();
      return /you|player 1|\(you\)/i.test(loser) ? { kind: 'loss', raw: t } : { kind: 'win', raw: t };
    }
    // A genuine blackjack moment, not the persistent "Blackjack PvP" header.
    if (/\bblackjack\b/i.test(t) && /!\b|won|win(?!(ner|ning))|\b21\b/i.test(t)) return { kind: 'blackjack', raw: t };
    if (/\b(?:push|tie)\b/i.test(t)) return { kind: 'push', raw: t };
    if (/\bwon\b|\bwin(?!ner|ning)\b|victor/i.test(t)) return { kind: 'win', raw: t };
    if (/\blost\b|\blose(?!rs?)\b/i.test(t)) return { kind: 'loss', raw: t };
  }
  return null;
}

function ev(o: ObsText, type: string, confidence: number, importance: Importance, evidence: string[], extra: Partial<GameplayEvent> = {}): GameplayEvent {
  return {
    type,
    timestamp: o.t,
    confidence,
    importance,
    evidence,
    sourceObservations: [o.obs],
    game: 'blackjack',
    metadata: { image: o.image, ...extra.metadata },
    ...extra,
  };
}

export const blackjackAnalyzer: GameAnalyzer = {
  game: 'blackjack',

  analyze({ observations }) {
    const events: GameplayEvent[] = [];
    const list: ObsText[] = observations
      .map((obs) => ({ t: obs.timestamp, image: obs.image, text: obs.text, obs }))
      .filter((o) => o.text.trim().length > 0)
      .sort((a, b) => a.t - b.t);

    let lastRound = 0;
    let playerScore: { value: number; t: number; image: string } | null = null;
    let handSeen = false;
    let lastEmit: Record<string, number> = {};
    const canEmit = (type: string, t: number, gapSec = 1.0) => {
      const last = lastEmit[type];
      if (last !== undefined && t - last < gapSec) return false;
      lastEmit[type] = t;
      return true;
    };

    for (const o of list) {
      const score = playerScoreOf(o);
      const dealer = dealerScoreOf(o);
      const round = roundOf(o);

      // Round start
      if (round !== null && round !== lastRound) {
        if (lastRound === 0) {
          events.push(ev(o, 'blackjack_round_start', 0.85, 'normal', [`t=${o.t.toFixed(2)} ${o.image}: "Round ${round}"`], { metadata: { round } }));
        } else if (round > lastRound && canEmit('blackjack_round_start', o.t, 4)) {
          events.push(ev(o, 'blackjack_round_start', 0.85, 'normal', [`t=${o.t.toFixed(2)} ${o.image}: round ${lastRound} -> ${round}`], { metadata: { round } }));
        }
        lastRound = round;
      }

      // Dealer hand visible
      if (dealer !== null && canEmit('blackjack_dealer_hand', o.t, 2)) {
        events.push(ev(o, 'blackjack_dealer_hand', 0.7, 'normal', [`t=${o.t.toFixed(2)} ${o.image}: dealer at ${dealer} pts`], { metadata: { dealer } }));
      }

      // Player hand / score transitions (temporal state machine)
      if (score !== null) {
        if (playerScore === null || playerScore.value === 0) {
          if (score > 0 && canEmit('blackjack_hand', o.t, 2)) {
            events.push(ev(o, 'blackjack_hand', 0.75, 'normal', [`t=${o.t.toFixed(2)} ${o.image}: player hand shows ${score} pts`], { metadata: { score } }));
            handSeen = true;
          }
        } else if (score !== playerScore.value) {
          const prev = playerScore.value;
          if (score > prev) {
            if (score > 21) {
              if (canEmit('blackjack_bust', o.t, 2)) {
                const bustWord = resultOf(o);
                events.push(
                  ev(o, 'blackjack_bust', bustWord?.kind === 'bust' ? 0.93 : 0.78, 'major',
                    [`t=${o.t.toFixed(2)} ${o.image}: score ${prev} -> ${score} pts crosses 21`, bustWord ? `OCR: ${bustWord.raw}` : 'no literal Bust word recognized'],
                    { metadata: { from: prev, to: score, sudden: true } })
                );
              }
            } else if (score === 21) {
              if (canEmit('blackjack_twenty_one', o.t, 3)) {
                events.push(ev(o, 'blackjack_twenty_one', 0.72, 'highlight', [`t=${o.t.toFixed(2)} ${o.image}: reached 21 from ${prev}`], { metadata: { from: prev, to: score } }));
              }
            } else {
              if (canEmit('blackjack_score_change', o.t, 2)) {
                events.push(ev(o, 'blackjack_score_change', 0.8, 'important', [`t=${o.t.toFixed(2)} ${o.image}: score ${prev} -> ${score} pts`], { metadata: { from: prev, to: score } }));
              }
            }
          } else if (score === 0 || score < prev) {
            // Hand cleared / new hand started
            if (canEmit('blackjack_round_end', o.t, 3)) {
              events.push(ev(o, 'blackjack_round_end', 0.7, 'normal', [`t=${o.t.toFixed(2)} ${o.image}: hand reset ${prev} -> ${score}`], { metadata: { from: prev, to: score } }));
            }
            handSeen = false;
          }
        }
        playerScore = { value: score, t: o.t, image: o.image };
      }

      // Explicit outcomes
      const result = resultOf(o);
      if (result) {
        const typeMap: Record<string, { type: string; importance: Importance; conf: number }> = {
          win: { type: 'blackjack_win', importance: 'highlight', conf: 0.85 },
          loss: { type: 'blackjack_loss', importance: 'highlight', conf: 0.85 },
          push: { type: 'blackjack_push', importance: 'normal', conf: 0.8 },
          bust: { type: 'blackjack_bust', importance: 'major', conf: 0.93 },
          blackjack: { type: 'blackjack_blackjack', importance: 'major', conf: 0.9 },
        };
        const mapped = typeMap[result.kind];
        if (mapped && canEmit(mapped.type, o.t, 4)) {
          events.push(ev(o, mapped.type, mapped.conf, mapped.importance, [`t=${o.t.toFixed(2)} ${o.image}: OCR "${result.raw}"`], {}));
        }
      }

      // A hand that stays visible for a while without change is just stable; nothing to emit.
      void handSeen;
    }

    if (playerScore !== null) {
      events.push({
        type: 'blackjack_state',
        timestamp: playerScore.t,
        confidence: 1,
        importance: 'normal',
        evidence: [`final observed player score ${playerScore.value} pts`],
        game: 'blackjack',
        metadata: { finalScore: playerScore.value, displayed: true },
      });
    }

    return events;
  },
};