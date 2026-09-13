export type GameId = 'blackjack' | 'roulette' | 'crash' | 'plinko' | 'unknown';

export const ANALYSIS_VERSION = '1.0';

export type Importance = 'normal' | 'important' | 'highlight' | 'major';

export interface OcrWordBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLineData {
  text: string;
  words: OcrWordBox[];
}

/**
 * One OCR pass over a single sampled frame. `confidence` is normally null:
 * the Windows OCR engine does not expose per-result confidence, so we never
 * invent one.
 */
export interface OcrObservation {
  /** Source time in the recording, seconds. */
  timestamp: number;
  /** Frame file this observation came from (basename). */
  image: string;
  /** All recognized text concatenated with ", ". */
  text: string;
  lines: OcrLineData[];
  confidence: number | null;
}

export type EventType =
  | 'blackjack_round_start'
  | 'blackjack_hand'
  | 'blackjack_dealer_hand'
  | 'blackjack_score_change'
  | 'blackjack_twenty_one'
  | 'blackjack_bust'
  | 'blackjack_blackjack'
  | 'blackjack_win'
  | 'blackjack_loss'
  | 'blackjack_push'
  | 'blackjack_round_end'
  | 'roulette_round_start'
  | 'roulette_result'
  | 'crash_multiplier_change'
  | 'crash_end'
  | 'crash_round_start'
  | 'plinko_round_start'
  | 'plinko_result'
  | 'plinko_round_end'
  | string;

export interface GameplayEvent {
  type: EventType;
  timestamp: number;
  /** 0..1. Derived from evidence strength; never fabricated. */
  confidence: number;
  importance: Importance;
  /** Why this event was detected (OCR quotes, score transitions, frame refs). */
  evidence: string[];
  /** Optional time span the event refers to. */
  startTime?: number;
  endTime?: number;
  /** The OCR observations used to derive the event. */
  sourceObservations?: OcrObservation[];
  game?: GameId;
  metadata?: Record<string, unknown>;
}

export interface ImportantMoment {
  eventType: string;
  timestamp: number;
  importance: Importance;
  /** Deterministic ranking score, higher = stronger. */
  score: number;
  confidence: number;
  reason: string;
}

export interface GameIdentification {
  game: GameId;
  confidence: number;
  reasons: string[];
}

export interface AnalysisSampling {
  fps: number;
  frameCount: number;
  format: 'jpg' | 'png';
  /** Nominal source times of each sampled frame (i / fps). */
  times: number[];
  framesDir: string;
  reused: boolean;
}

export interface GameplayAnalysis {
  schemaVersion: 1;
  source: string;
  game: GameId;
  gameConfidence: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  sampling: AnalysisSampling;
  ocr: {
    engine: string | null;
    locale: string | null;
    wordCount: number;
  };
  observations: OcrObservation[];
  events: GameplayEvent[];
  importantMoments: ImportantMoment[];
  /** Kept for pipeline compatibility; always null in this step. */
  suggestedHeadline: string | null;
  payoff: unknown;
  /** Legacy batch-compat: paths of the frame files used for analysis. */
  sampledFrames: string[];
  analysisVersion: string;
  errors: string[];
  warnings: string[];
}