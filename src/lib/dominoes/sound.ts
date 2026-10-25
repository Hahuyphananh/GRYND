/**
 * Dominoes — the table's SOUND.
 *
 * A played tile lands with a wooden double-clack; a draw slides a tile off the
 * pile; a pass is a single tap. They are SYNTHESISED with the Web Audio API
 * instead of shipped as files: two short bursts of filtered noise plus a low
 * thud are all a domino needs, and a few hundred bytes of JS beat three audio
 * assets that have to load, decode and fail separately on a phone.
 *
 * ── IT MUST NEVER BREAK A MOVE ────────────────────────────────────────────
 *
 * Sound is decoration. Every entry point is a no-op when there is no browser, no
 * AudioContext, no user gesture yet, or a muted preference — and every call is
 * wrapped, so a refused audio context can never surface as a rejected action.
 *
 * The context is created lazily on the first sound (which happens in the same
 * task as a player's click, so autoplay policy allows it) and is resumed if the
 * browser suspended it. A later opponent move reuses that unlocked context.
 */

export type DominoSound = "place" | "draw" | "pass";

/** Where the mute preference lives. A device preference, like the AI tier. */
const STORAGE_KEY = "grynd:dominoes-sound";

type AudioContextLike = {
  currentTime: number;
  state?: string;
  destination: unknown;
  createOscillator: () => OscillatorLike;
  createGain: () => GainLike;
  createBiquadFilter: () => FilterLike;
  createBuffer?: (channels: number, frames: number, rate: number) => AudioBufferLike;
  createBufferSource?: () => BufferSourceLike;
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
  sampleRate: number;
};

type OscillatorLike = {
  type: string;
  frequency: { value: number; setValueAtTime: (v: number, t: number) => void; exponentialRampToValueAtTime: (v: number, t: number) => void };
  connect: (node: unknown) => void;
  start: (when: number) => void;
  stop: (when: number) => void;
};

type GainLike = {
  gain: {
    value: number;
    setValueAtTime: (v: number, t: number) => void;
    linearRampToValueAtTime: (v: number, t: number) => void;
    exponentialRampToValueAtTime: (v: number, t: number) => void;
  };
  connect: (node: unknown) => void;
};

type FilterLike = {
  type: string;
  frequency: { value: number; setValueAtTime: (v: number, t: number) => void };
  Q: { value: number };
  connect: (node: unknown) => void;
};

type AudioBufferLike = { getChannelData: (channel: number) => Float32Array };
type BufferSourceLike = {
  buffer: AudioBufferLike | null;
  connect: (node: unknown) => void;
  start: (when: number) => void;
};

let context: AudioContextLike | null = null;
let unavailable = false;

/** The browser's AudioContext constructor, or null when there is none. */
function audioContextConstructor(): (new () => AudioContextLike) | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** The shared audio context, created on first use. Null when audio is impossible. */
function ensureContext(): AudioContextLike | null {
  if (context) {
    if (context.state === "suspended" && typeof context.resume === "function") {
      void context.resume().catch(() => {});
    }
    return context;
  }
  if (unavailable) return null;
  const Constructor = audioContextConstructor();
  if (!Constructor) {
    unavailable = true;
    return null;
  }
  try {
    context = new Constructor();
    return context;
  } catch {
    unavailable = true;
    return null;
  }
}

/**
 * Warm up the audio context from a REAL user gesture.
 *
 * Browsers create an AudioContext suspended until the page has been interacted
 * with, and a context resumed outside that gesture stays silent. Sound is driven
 * by the snapshot advancing — which happens after an opponent's move, not inside
 * a click — so the board calls this once on the first tap or key press. It makes
 * no sound itself: it only ensures the next tile to land is heard.
 */
export function unlockDominoSound(): void {
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === "suspended" && typeof ctx.resume === "function") {
    void ctx.resume().catch(() => {});
  }
}

/** True when the player has switched the table's sound off on this device. */
export function isDominoSoundMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "off";
  } catch {
    // A private-mode browser can throw on localStorage; sound stays on.
    return false;
  }
}

/** Persist the mute preference. Storage failures are ignored (never a hard error). */
export function setDominoSoundMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? "off" : "on");
  } catch {
    // Ignore: the preference is a convenience, not a requirement.
  }
}

/** One short percussive burst: filtered noise through a fast-decaying envelope. */
function burst(ctx: AudioContextLike, at: number, options: {
  frequency: number;
  q?: number;
  gain: number;
  duration: number;
}) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * options.duration));
  const createSource = ctx.createBufferSource;
  const createBuffer = ctx.createBuffer;
  if (!createSource || !createBuffer) return;

  const buffer = createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    // A decaying noise burst: sharp attack, smooth tail.
    const decay = 1 - index / data.length;
    data[index] = (Math.random() * 2 - 1) * decay * decay;
  }

  const source = createSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(options.frequency, at);
  filter.Q.value = options.q ?? 0.9;

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(options.gain, at + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + options.duration);

  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(ctx.destination);
  source.start(at);
}

/** One low thud, which is what makes two bursts read as wood rather than clicks. */
function thud(ctx: AudioContextLike, at: number, options: {
  frequency: number;
  gain: number;
  duration: number;
}) {
  const oscillator = ctx.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(options.frequency, at);
  oscillator.frequency.exponentialRampToValueAtTime(options.frequency * 0.6, at + options.duration);

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(options.gain, at + 0.006);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + options.duration);

  oscillator.connect(envelope);
  envelope.connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + options.duration + 0.02);
}

/**
 * Play one table sound. Never throws, never returns anything, and does nothing
 * when sound is muted or the browser has no audio.
 */
export function playDominoSound(kind: DominoSound): void {
  try {
    if (isDominoSoundMuted()) return;
    const ctx = ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime + 0.001;

    switch (kind) {
      case "place": {
        // Two clacks and a thud: the tile lands, then settles.
        burst(ctx, now, { frequency: 2200, gain: 0.16, duration: 0.05 });
        thud(ctx, now, { frequency: 190, gain: 0.09, duration: 0.09 });
        burst(ctx, now + 0.055, { frequency: 1500, gain: 0.07, duration: 0.045 });
        break;
      }
      case "draw": {
        // A soft slide: filtered noise with no sharp attack.
        burst(ctx, now, { frequency: 900, q: 0.6, gain: 0.05, duration: 0.14 });
        break;
      }
      case "pass":
      default: {
        // A single quiet tap on the felt.
        burst(ctx, now, { frequency: 1200, gain: 0.05, duration: 0.04 });
        break;
      }
    }
  } catch {
    // Sound is decoration: a refused context must never disturb the move.
  }
}
