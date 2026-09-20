// qa/fiar-audio.mjs
//
// Records Four-In-A-Row's sound cues in the browser checks.
//
// Rather than faking the Web Audio API (which would only let a check count
// oscillators and guess which cue they belonged to), this stubs
// `lib/fourInARowAudio` with a thin WRAPPER around the real module: every cue
// records its own name on `window.__fiarCues` and then delegates to the real
// implementation. So the checks assert on the exact cue the page asked for,
// while the real module still runs (its mute gate, its shared context, its
// audibility).
//
// The wrapper imports the real file by a specifier that deliberately does NOT
// match its own stub filter (`…/lib/fourInARowAudio$`), so it resolves normally
// instead of recursing.
//
// Used by qa/fiar-audio-check.mjs, and added to both shared harness modules so
// every page check sees the same (harmless) instrumentation.

export const AUDIO_STUB = {
  match: /lib\/fourInARowAudio$/,
  source: `
import * as real from "./src/lib/fourInARowAudio.ts";

const rec = (window.__fiarCues = window.__fiarCues || []);
const wrap = (name, label) => (...args) => {
  rec.push({ cue: label ? label(args) : name, at: performance.now() });
  return real[name](...args);
};

export const playFiarSelect = wrap("playFiarSelect", () => "select");
// The landing cue carries who landed: YOUR disc or the opponent's.
export const playFiarLand = wrap("playFiarLand", (a) =>
  a[0] === false ? "opponentLand" : "land",
);
export const playFiarOpponentLand = wrap("playFiarOpponentLand", () => "opponentLand");
export const playFiarMatchStart = wrap("playFiarMatchStart", () => "matchStart");
export const playFiarWin = wrap("playFiarWin", () => "win");
export const playFiarLoss = wrap("playFiarLoss", () => "loss");
export const playFiarDraw = wrap("playFiarDraw", () => "draw");
`,
};

/** Every cue recorded so far, in order. */
export const readCues = (page) =>
  page.evaluate(() => (window.__fiarCues || []).map((c) => c.cue));

/** How many times a single cue has fired. */
export const countCue = async (page, cue) =>
  (await readCues(page)).filter((c) => c === cue).length;

/** Forget everything recorded so far (the recorder array is mutated in place so
 *  the stub's captured reference stays valid). */
export const clearCues = (page) =>
  page.evaluate(() => {
    if (window.__fiarCues) window.__fiarCues.length = 0;
  });
