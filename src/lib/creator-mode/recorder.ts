// src/lib/creator-mode/recorder.ts
//
// In-page viewport recorder for Creator Mode. Records ONLY the game
// container that the host marks up — never the browser tab, desktop,
// taskbar, or other applications — and runs entirely inside the website
// with zero new dependencies and no screen-sharing permission prompts.
//
// How it works (browser-native, chosen per rendering technology — see
// docs/CREATOR_MODE_RECORDING.md for the full rationale):
//
//   • Canvas / WebGL games   — the dominant <canvas> is drawn straight
//     into an output canvas each animation frame ("canvas mode"). Exact,
//     synchronous, full frame rate.
//
//   • DOM / SVG / mixed games — the container's DOM is serialized into
//     an inline <style> + <foreignObject> SVG data URL each frame, drawn
//     into the output canvas, then any live <canvas> elements in the
//     container are composited on top ("composite mode"). This uses the
//     browser's own SVG rasterizer, so page styles, Tailwind classes,
//     inline styles and SVG all render — verified to stay origin-clean
//     so `captureStream()` can record it.
//
// The output canvas is always the SELECTED recording dimensions (aspect
// ratio / custom size), so the creator never resizes their browser — the
// game renders inside a dedicated recording viewport of that size and
// the frame is CSS-scaled on screen while capture runs at logical size.
//
// Non-interference: the recorder only READS the DOM (cloneNode +
// getBoundingClientRect + drawImage). It attaches no input listeners,
// pauses nothing, and alters no timers/animations/game state — gameplay
// input flows straight through the viewport container.
//
// Known limitations (documented in docs/CREATOR_MODE_RECORDING.md):
//   • CSS keyframe animations inside the container render as static
//     (SVG images don't run animations) — inline-style-driven movement
//     (React updates) IS captured per frame.
//   • <canvas>/WebGL content inside the DOM snapshot renders blank, so
//     live canvases are composited on top afterwards (positioned via
//     layout math that is robust to the viewport's CSS transform).
//   • Cross-origin images would taint the canvas and are excluded by the
//     origin-clean probe — the recorder fails with a clear error instead
//     of silently producing a broken/black recording.
//   • Relative URLs in serialized HTML/CSS are absolutized; exotic CSS
//     (external @import, some blend modes) may not rasterize identically.
//
// The engine is framework-free; React integration lives in
// useCreatorRecorder.ts.

import {
  CANVAS_MODE_AREA_THRESHOLD,
  type CaptureDimensions,
  type CaptureSourceMode,
  type RecordingResult,
  type RecordingState,
} from "./types";
import { getAudioTapStream } from "./audioTap";

// ── Feature detection / codec support ─────────────────────────────────

/** True when the browser can run the in-page recorder at all. */
export function isViewportRecordingSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

/** Pick the best supported MediaRecorder mime type (graceful fallback).
 *  MP4 (H.264 + AAC) is preferred — it plays everywhere and is what
 *  creators want to share — with WebM (VP9/VP8 + Opus) as the fallback
 *  for browsers that only record WebM (e.g. Firefox). */
export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return "";
}

// ── Geometry helpers ──────────────────────────────────────────────────

/** Letterbox fit: map a source rect into a destination rect preserving
 *  aspect ratio (no distortion, centered, black bars where needed). */
export function fitRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { x: number; y: number; w: number; h: number; scale: number } {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h, scale };
}

// ── DOM serialization for the composite snapshot ─────────────────────

/** Absolutize relative url(...) tokens in a CSS string. */
function absolutizeCssUrls(css: string): string {
  if (!css.includes("url(")) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, raw) => {
    const trimmed = raw.trim();
    // data: and # are already self-contained; absolute http(s) need no
    // rewrite. Everything else (relative paths, root-relative, and
    // protocol-relative //host) is resolved against the page URL so it
    // resolves inside the data-URL SVG image.
    if (
      !trimmed ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("http:") ||
      trimmed.startsWith("https:")
    ) {
      return match;
    }
    try {
      return `url(${quote}${new URL(trimmed, location.href).href}${quote})`;
    } catch {
      return match;
    }
  });
}

/** Collect the page's stylesheets (cached by the caller). */
export function collectPageCss(): string {
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\n";
    } catch {
      // cross-origin stylesheet — skip (can't read its rules)
    }
  }
  return absolutizeCssUrls(css);
}

/**
 * Serialize a container element into XHTML suitable for a <foreignObject>.
 * Strips non-rasterizable/unsafe nodes (canvas is composited separately,
 * scripts/iframes do nothing in an image) and absolutizes URLs so
 * same-origin assets resolve inside the data-URL SVG.
 */
export function serializeContainer(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("canvas,script,iframe,noscript,object,embed").forEach((n) => n.remove());

  // Absolutize src/srcset/poster and inline-style url()s.
  clone.querySelectorAll<HTMLImageElement | HTMLSourceElement | HTMLVideoElement>(
    "img,source,video",
  ).forEach((el) => {
    const src = el.getAttribute("src");
    if (src) {
      try {
        el.setAttribute("src", new URL(src, location.href).href);
      } catch {
        // leave as-is
      }
    }
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      el.setAttribute(
        "srcset",
        srcset
          .split(",")
          .map((part) => {
            const [urlPart, ...rest] = part.trim().split(/\s+/);
            try {
              return [new URL(urlPart, location.href).href, ...rest].join(" ");
            } catch {
              return part;
            }
          })
          .join(", "),
      );
    }
    const poster = (el as HTMLVideoElement).getAttribute?.("poster");
    if (poster) {
      try {
        (el as HTMLVideoElement).setAttribute("poster", new URL(poster, location.href).href);
      } catch {
        // leave as-is
      }
    }
  });

  // Inline style url()s (rare, but background-image etc. appear inline).
  clone.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const style = el.getAttribute("style");
    if (style && style.includes("url(")) {
      el.setAttribute("style", absolutizeCssUrls(style));
    }
  });

  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Probe whether composite (DOM) capture works in this browser: load one
 * data-URL foreignObject snapshot, draw it, and verify the canvas stays
 * origin-clean AND something was actually painted (covers browsers that
 * silently render foreignObject blank or taint the canvas). Called once
 * when composite mode starts — a tainted canvas would make
 * captureStream throw, so we fail loudly instead of recording black.
 */
async function probeComposite(
  container: HTMLElement,
  css: string,
  width: number,
  height: number,
): Promise<boolean> {
  try {
    const html = serializeContainer(container);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<style>${css}</style>` +
      `<foreignObject width="${width}" height="${height}">${html}</foreignObject></svg>`;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("snapshot failed to load"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < data.length; i += 997) {
      if (data[i] || data[i + 1] || data[i + 2]) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Pick the capture source mode for a container:
 *   "canvas"    — a single dominant canvas covers the container
 *   "composite" — DOM/SVG/mixed rendering (DOM snapshot + canvas overlay)
 *   "none"      — empty container
 */
export function detectSourceMode(container: HTMLElement): CaptureSourceMode {
  const containerArea = container.offsetWidth * container.offsetHeight;
  if (!containerArea || containerArea <= 0) return "none";
  const canvases = Array.from(container.querySelectorAll("canvas")).filter(
    (c) => c.width > 0 && c.height > 0,
  );
  if (canvases.length === 0) return "composite";
  const dominant = canvases.reduce((a, b) =>
    a.width * a.height > b.width * b.height ? a : b,
  );
  const coverage = (dominant.width * dominant.height) / containerArea;
  return coverage >= CANVAS_MODE_AREA_THRESHOLD ? "canvas" : "composite";
}

// ── Recorder ──────────────────────────────────────────────────────────

type StartOptions = {
  /** The recording viewport element (the game container). */
  container: HTMLElement;
  /** Output recording dimensions (selected aspect ratio / custom). */
  width: number;
  height: number;
  /** Target capture frame rate. */
  fps?: number;
};

type RecorderCallbacks = {
  onStateChange?: (state: RecordingState) => void;
};

export class CreatorRecorder {
  private container: HTMLElement | null = null;
  private sourceMode: CaptureSourceMode = "none";

  private output: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  private raf = 0;
  private lastFrameAt = 0;
  private frameBusy = false;
  private frameIntervalMs = 1000 / 15;
  private snapshotImg: HTMLImageElement | null = null;
  private cssCache = "";
  private cssCachedAt = 0;

  private startedAt = 0;
  private requesting = false;
  private result: RecordingResult | null = null;

  dimensions: CaptureDimensions | null = null;
  error: string | null = null;
  sourceModeUsed: CaptureSourceMode | null = null;

  private onStateChange: RecorderCallbacks["onStateChange"];

  constructor(callbacks: RecorderCallbacks = {}) {
    this.onStateChange = callbacks.onStateChange;
  }

  setOnStateChange(callback: RecorderCallbacks["onStateChange"]): void {
    this.onStateChange = callback;
  }

  get state(): RecordingState {
    // A finished recording takes precedence over the (now-null) recorder.
    if (this.result) return "stopped";
    if (!this.recorder) return "idle";
    if (this.recorder.state === "recording" || this.recorder.state === "paused") {
      return "recording";
    }
    return "idle";
  }

  get isRecording(): boolean {
    return this.state === "recording";
  }

  get lastResult(): RecordingResult | null {
    return this.result;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Begin in-page capture of the given container at the given output
   * dimensions. Returns true when recording actually started.
   */
  async start(options: StartOptions): Promise<boolean> {
    if (this.isRecording) return true;
    if (this.requesting) return false;
    if (!isViewportRecordingSupported()) {
      this.error = "Screen recording is not supported in this browser.";
      this.onStateChange?.("error");
      return false;
    }

    const { container, width, height, fps } = options;
    if (!container || !container.isConnected) {
      this.error = "Recording viewport is not available.";
      this.onStateChange?.("error");
      return false;
    }
    const safeW = Math.max(1, Math.round(width));
    const safeH = Math.max(1, Math.round(height));

    this.requesting = true;
    try {
      // A new capture invalidates the previous result — release its
      // object URL immediately so media resources never accumulate.
      if (this.result) {
        URL.revokeObjectURL(this.result.url);
        this.result = null;
      }
      // Reset from a previous capture.
      this.releaseResources(true);

      const mode = detectSourceMode(container);
      if (mode === "none") {
        this.error = "The game viewport is empty — nothing to record.";
        this.requesting = false;
        this.onStateChange?.("error");
        return false;
      }

      // Composite (DOM) mode needs a one-shot origin-clean probe before
      // we commit: a tainted canvas makes captureStream throw, so we
      // fail loudly rather than record a broken/black video.
      if (mode === "composite") {
        this.cssCache = collectPageCss();
        this.cssCachedAt = Date.now();
        const probeOk = await probeComposite(container, this.cssCache, 64, 64);
        if (!probeOk) {
          // Best compatible fallback: if a dominant canvas exists, use
          // canvas mode instead of giving up silently.
          const canvases = Array.from(container.querySelectorAll("canvas")).filter(
            (c) => c.width > 0 && c.height > 0,
          );
          if (canvases.length > 0) {
            this.sourceMode = "canvas";
          } else {
            this.error =
              "In-page DOM capture is not supported in this browser (the canvas would be tainted, which browsers refuse to record).";
            this.requesting = false;
            this.onStateChange?.("error");
            return false;
          }
        } else {
          this.sourceMode = "composite";
        }
      } else {
        this.sourceMode = mode;
      }
      this.sourceModeUsed = this.sourceMode;
      this.frameIntervalMs = 1000 / Math.max(1, Math.min(60, fps ?? (this.sourceMode === "canvas" ? 30 : 15)));

      this.container = container;
      this.output = document.createElement("canvas");
      this.output.width = safeW;
      this.output.height = safeH;
      this.ctx = this.output.getContext("2d");
      if (!this.ctx) {
        this.error = "Could not create the recording canvas.";
        this.requesting = false;
        this.onStateChange?.("error");
        return false;
      }
      this.dimensions = { width: safeW, height: safeH };

      // Black letterbox base.
      this.ctx.fillStyle = "#000000";
      this.ctx.fillRect(0, 0, safeW, safeH);

      // captureStream is not actually "requesting" a permission — keep
      // the state vocabulary meaningful for the UI.
      this.chunks = [];
      this.startedAt = Date.now();
      const mimeType = pickMimeType();
      try {
        this.stream = this.output.captureStream(
          this.sourceMode === "canvas" ? 30 : Math.min(30, Math.round(1000 / this.frameIntervalMs)),
        );
        // Add the game's audio: every game routes its Web Audio sounds
        // through the shared context tap, so this one track carries all
        // sound effects. The track is page-wide and shared — we only
        // borrow it (never stop it; see releaseResources/finalize).
        const audioStream = getAudioTapStream();
        if (audioStream) {
          try {
            audioStream
              .getAudioTracks()
              .forEach((track) => this.stream?.addTrack(track));
          } catch {
            // audio is best-effort — video-only recording is still fine
          }
        }
        this.recorder = mimeType
          ? new MediaRecorder(this.stream, { mimeType })
          : new MediaRecorder(this.stream);
      } catch (err) {
        this.error = `Recording could not start: ${err instanceof Error ? err.message : "unknown error"}`;
        this.requesting = false;
        this.onStateChange?.("error");
        return false;
      }

      this.recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) this.chunks.push(event.data);
      });
      this.recorder.addEventListener("stop", () => this.finalize());

      this.recorder.start(1000);
      this.lastFrameAt = performance.now();
      this.raf = requestAnimationFrame(this.loop);
      this.requesting = false;
      this.onStateChange?.("recording");
      return true;
    } catch (err) {
      this.requesting = false;
      this.error = `Could not start recording: ${err instanceof Error ? err.message : "unknown error"}`;
      this.releaseResources(true);
      this.onStateChange?.("error");
      return false;
    }
  }

  /** Finish the capture and produce a downloadable recording. */
  stop(): void {
    if (!this.recorder || this.recorder.state === "inactive") {
      // Nothing recording — still release any dangling capture state.
      this.releaseResources(true);
      return;
    }
    this.cancelAnimation();
    try {
      this.recorder.stop();
    } catch {
      // Already inactive — nothing to stop.
    }
    // finalize() runs from the recorder's onstop handler.
  }

  /** Abort without producing a recording (e.g. page unload). */
  cancel(): void {
    this.cancelAnimation();
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    this.chunks = [];
    // Release the previous result's object URL so cancel never leaks.
    if (this.result) {
      URL.revokeObjectURL(this.result.url);
      this.result = null;
    }
    this.releaseResources(true);
    this.onStateChange?.("idle");
  }

  /**
   * Throw away the finished recording: release its object URL and all
   * capture resources, then return to idle (armed). Used by the result
   * panel's Discard / Record-another actions. The recording is never
   * uploaded anywhere — discarding deletes it from the browser.
   */
  discard(): void {
    this.cancelAnimation();
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    if (this.result) {
      URL.revokeObjectURL(this.result.url);
      this.result = null;
    }
    this.error = null;
    this.releaseResources(true);
    this.onStateChange?.("idle");
  }

  /**
   * Trigger a browser download of the most recent recording.
   * @returns the filename used, or null when there is nothing to download.
   */
  download(filenameBase = "grynd-creator-recording"): string | null {
    const result = this.result;
    if (!result) return null;
    const extension = result.mimeType.includes("mp4") ? "mp4" : "webm";
    // grynd-{game}-{date}-{time}.webm — e.g. grynd-plinko-duel-2026-08-30-14-32-05.webm
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const filename = `${filenameBase}-${date}-${time}.${extension}`;
    const anchor = document.createElement("a");
    anchor.href = result.url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return filename;
  }

  /** Release every resource: animation, recorder, stream, canvases,
   *  snapshot image, chunks and object URLs. */
  dispose(): void {
    this.cancelAnimation();
    this.releaseResources(true);
    if (this.result) {
      URL.revokeObjectURL(this.result.url);
      this.result = null;
    }
    this.onStateChange?.("idle");
  }

  // ── Internals ─────────────────────────────────────────────────────

  private cancelAnimation(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.frameBusy = false;
  }

  /** Tear down capture plumbing. Keeps `result` unless reset is true. */
  private releaseResources(reset: boolean): void {
    this.cancelAnimation();
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    if (this.stream) {
      // Stop only the tracks WE created (the canvas capture). The audio
      // track is the shared page-wide audio tap — stopping it would kill
      // sound for the rest of the session.
      this.stream.getVideoTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.recorder = null;
    this.chunks = [];
    // Release the decoded snapshot image memory.
    if (this.snapshotImg) {
      try {
        this.snapshotImg.src = "";
      } catch {
        // ignore
      }
      this.snapshotImg = null;
    }
    if (reset) {
      this.output = null;
      this.ctx = null;
      this.container = null;
    }
  }

  /** MediaRecorder onstop: build the final Blob and surface it. */
  private finalize(): void {
    this.cancelAnimation();
    const durationMs = Date.now() - this.startedAt;
    const mimeType = this.recorder?.mimeType || "video/webm";

    // Revoke the previous download URL so object URLs never accumulate.
    if (this.result) {
      URL.revokeObjectURL(this.result.url);
      this.result = null;
    }

    if (this.chunks.length > 0) {
      const totalBytes = this.chunks.reduce((sum, c) => sum + c.size, 0);
      if (totalBytes === 0) {
        this.error = "Recording produced no frames.";
        this.onStateChange?.("error");
      } else {
        const blob = new Blob(this.chunks, { type: mimeType });
        this.result = {
          blob,
          url: URL.createObjectURL(blob),
          mimeType,
          dimensions: this.dimensions,
          durationMs,
        };
        this.onStateChange?.("stopped");
      }
    } else {
      this.error = "Recording stopped before any frames were captured.";
      this.onStateChange?.("error");
    }

    // Stop only the video track (ours). The audio track is the shared
    // page-wide tap — leaving it running lets the next recording reuse it.
    this.stream?.getVideoTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }

  // ── Frame loop ────────────────────────────────────────────────────

  private loop = (now: number): void => {
    if (this.state !== "recording" || !this.ctx || !this.container) return;
    const due = now - this.lastFrameAt >= this.frameIntervalMs;
    if (due && !this.frameBusy) {
      this.lastFrameAt = now;
      this.frameBusy = true;
      this.drawFrame().finally(() => {
        this.frameBusy = false;
        if (this.state === "recording") {
          this.raf = requestAnimationFrame(this.loop);
        }
      });
      return; // rescheduled in finally
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private drawFrame(): Promise<void> {
    if (!this.ctx || !this.container || !this.output) return Promise.resolve();
    return this.sourceMode === "canvas"
      ? Promise.resolve(this.drawCanvasFrame())
      : this.drawCompositeFrame();
  }

  /** Canvas mode: draw the dominant canvas into the output (fitted). */
  private drawCanvasFrame(): void {
    const container = this.container;
    const ctx = this.ctx;
    if (!container || !ctx || !this.output) return;
    const canvases = Array.from(container.querySelectorAll("canvas")).filter(
      (c) => c.width > 0 && c.height > 0,
    );
    const dominant = canvases.reduce((a, b) =>
      a.width * a.height > b.width * b.height ? a : b,
    );
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, this.output.width, this.output.height);
    const fit = fitRect(dominant.width, dominant.height, this.output.width, this.output.height);
    try {
      ctx.drawImage(dominant, fit.x, fit.y, fit.w, fit.h);
    } catch {
      // canvas content may be tainted by cross-origin images — leave the
      // black frame rather than crashing the loop.
    }
  }

  /** Composite mode: DOM snapshot + canvas overlay into the output. */
  private drawCompositeFrame(): Promise<void> {
    const container = this.container;
    const ctx = this.ctx;
    const output = this.output;
    if (!container || !ctx || !output) return Promise.resolve();

    // Refresh the stylesheet cache periodically (dynamic style injection).
    if (Date.now() - this.cssCachedAt > 2000) {
      this.cssCache = collectPageCss();
      this.cssCachedAt = Date.now();
    }
    const css = this.cssCache;

    const cw = container.offsetWidth || 1;
    const ch = container.offsetHeight || 1;
    const fit = fitRect(cw, ch, output.width, output.height);

    const html = serializeContainer(container);
    // Character-wise encoding means we can pre-encode the static head
    // (SVG + styles) once and only encode the per-frame HTML.
    const encodedHead = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}"><style>${css}</style><foreignObject width="${cw}" height="${ch}">`,
    );
    const encodedFoot = encodeURIComponent("</foreignObject></svg>");
    const url = `data:image/svg+xml;charset=utf-8,${encodedHead}${encodeURIComponent(html)}${encodedFoot}`;

    if (!this.snapshotImg) this.snapshotImg = new Image();
    const img = this.snapshotImg;
    img.src = url;

    return (img.decode ? img.decode() : Promise.resolve())
      .then(() => {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, output.width, output.height);
        ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);

        // Live canvas overlay: draw each <canvas> at its layout position.
        const cRect = container.getBoundingClientRect();
        if (cRect.width > 0 && cRect.height > 0) {
          container.querySelectorAll("canvas").forEach((cv) => {
            if (cv.width <= 0 || cv.height <= 0) return;
            const r = cv.getBoundingClientRect();
            const relX = ((r.left - cRect.left) / cRect.width) * cw;
            const relY = ((r.top - cRect.top) / cRect.height) * ch;
            const relW = (r.width / cRect.width) * cw;
            const relH = (r.height / cRect.height) * ch;
            try {
              ctx.drawImage(
                cv,
                fit.x + relX * fit.scale,
                fit.y + relY * fit.scale,
                relW * fit.scale,
                relH * fit.scale,
              );
            } catch {
              // tainted canvas — skip it rather than fail the frame
            }
          });
        }
      })
      .catch(() => {
        // A snapshot that fails to decode (e.g. oversized data URL on a
        // constrained device) leaves the previous frame — do not throw
        // out of the loop.
      });
  }
}
