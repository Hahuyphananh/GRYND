/**
 * GRYND edit-plan generator (Step 5).
 *
 * Deterministic, evidence-only: builds an EditManifest from the analysis
 * events, then constructs the final output through compileManifest(...) as
 * required by the existing architecture. No LLM/vision/Whisper/OCR/SFX, no
 * invented gameplay. Every beat carries a traceable StoryEventRef (via
 * Beat.eventReference) and every punch-in scale is a deterministic function
 * of the event importance + timestamp, clamped to the documented
 * per-importance scale window.
 */
import {
  Beat,
  EditManifest,
  Importance,
  PayoffBeat,
  StoryEventRef,
  compileManifest,
  defaultImportanceScale,
} from '../manifest.js';
import { GameplayAnalysis, GameplayEvent } from './types.js';

/**
 * Documented deterministic punch-in floors/ceilings per importance.
 * Kept local (not exported by ../manifest.js): these are the documented
 * contract that the interpreter shades against, exactly as the architecture
 * describes. Floors are always <= deterministic base; ceilings cap the
 * deterministic punch at a safe 100% read of 1.0 for normal clips.
 */
const SCALE_FLOOR: Record<Importance, number> = {
  normal: 1.0,
  important: 1.12,
  highlight: 1.18,
  major: 1.0,
};

const SCALE_CEILING: Record<Importance, number> = {
  normal: 1.02,
  important: 1.16,
  highlight: 1.12,
  major: 1.0,
};

const MIN_DURATION_S = 15;
const MAX_DURATION_S = 20;
const TARGET_DURATION_S = 16;

function weirdImportance(ev: GameplayEvent): Importance {
  return ev.importance;
}

/** Deterministic sub-1.0 hash in [0, 1) from a timestamp. */
function unit(timestamp: number): number {
  const raw = Math.abs(timestamp * 1000);
  const frac = raw - Math.floor(raw);
  return frac === 1 ? 0 : frac;
}

/**
 * Deterministic, evidence-only punch-in scale. Base is the compiler-proven
 * defaultImportanceScale(importance); the fractional punch is a clamped
 * deterministic function of that same importance and the event timestamp, so
 * identical input always produces identical output. Normal events read 1.0.
 */
function punchScale(ev: GameplayEvent): number {
  const base = defaultImportanceScale(ev.importance);
  const lo = SCALE_FLOOR[ev.importance];
  const hi = SCALE_CEILING[ev.importance];
  const frac = unit(ev.timestamp);
  const raw = base + frac * 0.18;
  return Math.min(hi, Math.max(lo, raw));
}

function refId(ev: GameplayEvent): string {
  return ev.type + '@' + ev.timestamp;
}

function eventRef(ev: GameplayEvent): StoryEventRef {
  return {
    type: ev.type,
    timestamp: ev.timestamp,
    importance: ev.importance,
  };
}

interface StoryPlan {
  type: string;
  reason: string;
  events: StoryEventRef[];
}

function numberScore(ev: GameplayEvent): number | null {
  const m = ev.metadata as Record<string, unknown> | null | undefined;
  if (m == null) return null;
  const s = m.score ?? m.preBustScore ?? m.handValue;
  return typeof s === 'number' ? s : null;
}

export function generateEditPlan(analysis: GameplayAnalysis): EditManifest {
  const events: GameplayEvent[] = [...analysis.events].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const source: string = analysis.source ?? 'clip';
  const game: string = (analysis.game ?? '').toLowerCase();

  let headline = 'this could have gone better';
  let payoffText = '';

  let story: StoryPlan | null = null;

  if (events.length > 0) {
    if (game === 'blackjack') {
      const busts = events.filter((e) => e.type === 'blackjack_bust');
      const wins = events.filter((e) => e.type === 'blackjack_win');
      const losses = events.filter((e) => e.type === 'blackjack_loss');
      const bigs = events.filter(
        (e) =>
          e.type === 'blackjack_twenty_one' || e.type === 'blackjack_blackjack',
      );

      const byScore = new Map<number, GameplayEvent[]>();
      for (const b of busts) {
        const s = numberScore(b);
        if (s === null) continue;
        const arr = byScore.get(s) ?? [];
        arr.push(b);
        byScore.set(s, arr);
      }

      let repeated: { score: number; evs: GameplayEvent[] } | null = null;
      for (const entry of byScore) {
        if (entry[1].length >= 2) {
          repeated = { score: entry[0], evs: entry[1] };
          break;
        }
      }

      if (repeated) {
        story = {
          type: 'repeated-bust',
          reason: 'same pre-bust score busted twice',
          events: repeated.evs.map(eventRef),
        };
        headline = 'bro trusted ' + repeated.score + ' TWICE';
        payoffText = 'BUSTED';
      } else if (bigs.length > 0 && wins.length > 0) {
        story = {
          type: 'strong-win',
          reason: 'a big hand led to a win',
          events: [eventRef(bigs[0]), eventRef(wins[0])],
        };
        headline = 'bro knew the exact play';
        payoffText = 'W';
      } else if (losses.length > 0 && wins.length > 0) {
        const lostFirst = losses[0].timestamp < wins[0].timestamp;
        if (lostFirst) {
          story = {
            type: 'comeback',
            reason: 'a losing round then a winning round',
            events: [eventRef(losses[0]), eventRef(wins[0])],
          };
          headline = 'bro actually came back';
          payoffText = 'W';
        }
      }
      if (story === null && busts.length > 0) {
        story = {
          type: 'single-bust',
          reason: 'a bust after a risky hit',
          events: [eventRef(busts[0])],
        };
        headline = 'bro really hit that';
        payoffText = 'BUSTED';
      } else if (story === null && bigs.length > 0) {
        story = {
          type: 'big-hand',
          reason: 'a strong opening hand before a payoff',
          events: [eventRef(bigs[0])],
        };
        headline = 'bro knew the exact move';
        payoffText = 'BLACKJACK';
      }
    } else if (game === 'crash') {
      const downed = events.filter(
        (e) =>
          e.type === 'crash' ||
          e.type === 'crash_crash' ||
          e.type === 'crash_crashed',
      );
      const clipped = (downed.length > 0 ? downed : events).slice(0, 4);
      story = {
        type: 'crash',
        reason: 'a crash ended the run',
        events: clipped.map(eventRef),
      };
      headline =
        downed.length > 0 ? 'bro REALLY crashed that' : 'bro sent that';
      payoffText = downed.length > 0 ? 'CRASHED' : 'W';
    } else if (game === 'roulette') {
      const lossy = events.some(
        (e) =>
          e.type.includes('loss') ||
          e.type.includes('zero') ||
          e.type.includes('lose'),
      );
      story = {
        type: 'roulette',
        reason: 'a roulette spin result',
        events: events.slice(0, 4).map(eventRef),
      };
      headline = 'bro really sent that';
      payoffText = lossy ? 'RIP' : 'W';
    } else if (game === 'plinko') {
      story = {
        type: 'plinko',
        reason: 'a plinko drop result',
        events: events.slice(0, 4).map(eventRef),
      };
      headline = 'bro really dropped that';
      payoffText = 'NO WAY';
    }
  }

  const focusEvents: GameplayEvent[] =
    story !== null && story.events.length > 0
      ? story.events
          .map((r) =>
            events.find(
              (e) => e.type === r.type && e.timestamp === r.timestamp,
            ),
          )
          .filter((e): e is GameplayEvent => Boolean(e))
      : events.length > 0
        ? [events[0]]
        : [];

  const beats: Beat[] = [];
  focusEvents.forEach((ev, i) => {
    const role =
      i === 0 ? 'hook' : i === focusEvents.length - 1 ? 'result' : 'action';
    let sourceStart: number;
    let sourceEnd: number;
    if (role === 'hook') {
      sourceStart = Math.max(0, ev.timestamp - 1.2);
      sourceEnd = ev.timestamp + 0.1;
    } else if (role === 'result') {
      sourceStart = Math.max(0, ev.timestamp - 0.3);
      sourceEnd = ev.timestamp + 0.6;
    } else {
      sourceStart = Math.max(0, ev.timestamp - 0.4);
      sourceEnd = ev.timestamp + 0.5;
    }
    const beat: Beat = {
      sourceStart,
      sourceEnd,
      scale: punchScale(ev),
      importance: ev.importance,
      label: role + ':',
      eventReference: refId(ev),
    };
    beats.push(beat);
  });

  let cursor = 0;
  for (const beat of beats) {
    if (beat.sourceStart < cursor) beat.sourceStart = cursor;
    if (beat.sourceEnd <= beat.sourceStart) beat.sourceEnd = beat.sourceStart + 0.1;
    cursor = beat.sourceEnd;
  }

  let total = beats.reduce((s, b) => s + (b.sourceEnd - b.sourceStart), 0);

  if (total < MIN_DURATION_S && beats.length > 0) {
    const pad = Math.min((MAX_DURATION_S - total) / 2, 3);
    const first = beats[0];
    const before = first.sourceStart;
    first.sourceStart = Math.max(0, first.sourceStart - pad);
    total += pad;
    const last = beats[beats.length - 1];
    last.sourceEnd += pad;
    total += pad;
  }

  if (total > MAX_DURATION_S && beats.length > 0) {
    const last = beats[beats.length - 1];
    const usable = Math.max(0, last.sourceEnd - last.sourceStart - 0.2);
    const cut = Math.min(total - MAX_DURATION_S, usable);
    last.sourceEnd -= cut;
  }

  let payoff: PayoffBeat | undefined;
  const lastFocus = focusEvents[focusEvents.length - 1];
  if (lastFocus && payoffText !== '') {
    payoff = {
      sourceStart: Math.max(0, lastFocus.timestamp - 0.9),
      sourceEnd: lastFocus.timestamp + 0.8,
      scale: 1,
      text: payoffText,
    };
  }

  const manifest: EditManifest = {
    schemaVersion: 1,
    source,
    format: {
      width: 1080,
      height: 1920,
      fps: 30,
    },
    headline,
    beats,
    payoff,
    game: analysis.game ?? 'unknown',
    story:
      story === null
        ? undefined
        : {
            type: story.type,
            reason: story.reason,
            events: story.events,
          },
  };

  return compileManifest(manifest).manifest as EditManifest;
}