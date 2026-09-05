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
//     inline styles and SVG all render. Every raster and CSS url() is
//     INLINED as a data URL before drawing and the CSS is compacted +
//     CDATA-wrapped — so the canvas always stays origin-clean and
//     `captureStream()` can record it. (The transport MUST be a data:
//     URL: drawing an SVG image from a blob: URL taints the canvas in
//     Chrome, verified experimentally.)
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
//   • Cross-origin images would taint the canvas (any http(s) image
//     referenced by an SVG-in-img loads without CORS), so every raster is
//     INLINED into the snapshot as a data URL before drawing (same-origin
//     and CORS-enabled images are fetched in; anything the browser won't
//     let us read becomes a transparent pixel). The snapshot is therefore
//     always self-contained and the canvas can never taint.
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
 * 1×1 transparent GIF. Substitutes any raster the recorder is not allowed
 * to read (cross-origin images served without CORS). Keeping the element
 * in place with a transparent source means layout is preserved AND the
 * snapshot can never taint the recording canvas.
 */
const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Fetch an image and return it as a data URL, or null when the browser
 * will not let us read it (no CORS headers) or the fetch fails. Data URLs
 * are self-contained: an SVG snapshot that only references data: rasters
 * can never taint a canvas, which is what lets captureStream record it.
 */
async function fetchImageAsDataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/") || blob.size <= 0) return null;
    // Guard: never inline huge media into a per-frame snapshot.
    if (blob.size > 6 * 1024 * 1024) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Resolve a src-ish token to an absolute http(s)/blob URL, or null when
 *  it is already self-contained (data:/#/empty). Blob URLs are NOT left
 *  as-is: inside an SVG-in-<img> a blob: raster is unreachable and can
 *  behave like a failed external load, so they are fetched (same-origin
 *  fetch works for blobs) and inlined like any other image. */
function absolutizeToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#")) {
    return null;
  }
  try {
    return new URL(trimmed, location.href).href;
  } catch {
    return null;
  }
}

/**
 * Serialize a container element into XHTML suitable for a <foreignObject>,
 * with every external raster INLINED so the resulting snapshot is fully
 * self-contained. This is what makes DOM capture possible at all: an SVG
 * drawn from a data: URL sits in an opaque origin, so ANY http(s) image
 * it references (even same-origin ones) loads without CORS and would
 * TAINT the canvas — browsers then refuse to record it. Inlining every
 * image as a data: URL (or a transparent pixel when the browser refuses
 * to read it) means the snapshot can never taint.
 *
 * Strips non-rasterizable/unsafe nodes (canvas is composited separately,
 * scripts/iframes/video do nothing inside an image).
 *
 * @param resolve      async (url → data URL | null) resolver (cached)
 * @param maxResolves  cap on how many distinct rasters get inlined per
 *                     call (probe uses a small cap so it stays instant;
 *                     real frames inline everything)
 */
async function serializeContainerClean(
  container: HTMLElement,
  resolve: (src: string) => Promise<string | null>,
  maxResolves = Infinity,
): Promise<string> {
  // ── Scroll preservation ─────────────────────────────────────────────
  // cloneNode(true) does NOT copy scroll offsets (verified in Chrome: a
  // scrolled element clones at scrollTop 0), so a naive snapshot would
  // always show every scrollable area at its TOP — in-game scrolling
  // (the [data-creator-fill] page scroll, chat/leaderboard panels)
  // would never appear in the recording. Capture the offsets of every
  // scrolled element and re-apply them to the clone. The index paths
  // are exact because the clone is still an identical copy of the
  // container at this point (nodes are stripped afterwards).
  const scrolls: Array<{ path: number[]; top: number; left: number }> =
    [];
  const collectScrolls = (el: Element, path: number[]): void => {
    if (el.scrollTop > 0 || el.scrollLeft > 0) {
      scrolls.push({ path, top: el.scrollTop, left: el.scrollLeft });
    }
    Array.from(el.children).forEach((child, i) =>
      collectScrolls(child, [...path, i]),
    );
  };
  collectScrolls(container, []);

  const clone = container.cloneNode(true) as HTMLElement;

  // ── Presentation-transform strip ────────────────────────────────────
  // The recording container itself carries the provider's on-screen
  // `transform: scale()` — the frame is CSS-scaled to fit the browser
  // window. Serialized verbatim, that inline transform would shrink the
  // WHOLE snapshot to the on-screen scale: whenever the window is
  // smaller than the capture size (the norm on laptops), the game
  // would record small and top-left inside a big black frame instead
  // of filling the output. Capture must run at the container's logical
  // size, so drop the container's OWN transform (+ origin) from the
  // clone. Transforms on descendants are untouched.
  clone.style.removeProperty("transform");
  clone.style.removeProperty("transform-origin");

  // Simulate the scrolled view in the clone. scrollTop/scrollLeft are
  // live layout properties, NOT HTML attributes — XMLSerializer cannot
  // carry them, and assigning them on a detached clone is a no-op in
  // Chrome (verified: a scrolled element clones at scrollTop 0 and the
  // assignment is ignored), so the foreignObject would re-layout the
  // clone at its TOP. Instead, translate each scrolled element's
  // children by the negative offset: the element's own overflow clip
  // makes that visually identical to the real scrolled view inside the
  // snapshot. The `translate` property (not `transform`) is used so a
  // child's own transform/animation is never clobbered. The clone is
  // still an exact structural copy at this point, so the index paths
  // map 1:1.
  for (const { path, top, left } of scrolls) {
    let node: Element = clone;
    let ok = true;
    for (const i of path) {
      const child = node.children[i];
      if (!child) {
        ok = false;
        break;
      }
      node = child;
    }
    if (ok) {
      const tx = left ? `${-left}px` : "0px";
      const ty = top ? `${-top}px` : "0px";
      for (const child of Array.from(node.children)) {
        (child as HTMLElement).style.translate = `${tx} ${ty}`;
      }
    }
  }

  clone
    .querySelectorAll(
      "canvas,script,iframe,noscript,object,embed,video,audio,link",
    )
    .forEach((n) => n.remove());

  let resolveBudget = maxResolves;
  const inline = async (abs: string): Promise<string> => {
    if (resolveBudget <= 0) return TRANSPARENT_PIXEL;
    resolveBudget -= 1;
    return (await resolve(abs)) || TRANSPARENT_PIXEL;
  };

  // <img>/<source> src + srcset: replace every http(s)/relative raster
  // with its inlined data URL.
  const media = Array.from(
    clone.querySelectorAll<HTMLImageElement | HTMLSourceElement>("img,source"),
  );
  for (const el of media) {
    const src = el.getAttribute("src");
    if (src) {
      const abs = absolutizeToken(src);
      if (abs) el.setAttribute("src", await inline(abs));
    }
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      const next: string[] = [];
      for (const part of srcset.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [urlPart, ...rest] = trimmed.split(/\s+/);
        const abs = absolutizeToken(urlPart);
        next.push([abs ? await inline(abs) : urlPart, ...rest].join(" "));
      }
      el.setAttribute("srcset", next.join(", "));
    }
  }

  // Inline style url()s (background-image etc.).
  const styled = Array.from(clone.querySelectorAll<HTMLElement>("[style]"));
  for (const el of styled) {
    const style = el.getAttribute("style");
    if (!style || !style.includes("url(")) continue;
    const regex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(style))) {
      out += style.slice(cursor, match.index);
      const abs = absolutizeToken(match[2]);
      out += abs ? `url(${await inline(abs)})` : match[0];
      cursor = match.index + match[0].length;
    }
    if (cursor < style.length) out += style.slice(cursor);
    if (out !== style) el.setAttribute("style", out);
  }

  // <style> elements living INSIDE the container (SVG games often carry
  // their own) — sanitize their url()s exactly like the page CSS.
  for (const styleEl of Array.from(clone.querySelectorAll<HTMLStyleElement>("style"))) {
    const css = styleEl.textContent || "";
    if (!css.includes("url(")) continue;
    const regex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(css))) {
      out += css.slice(cursor, match.index);
      const abs = absolutizeToken(match[2]);
      out += abs ? `url(${await inline(abs)})` : match[0];
      cursor = match.index + match[0].length;
    }
    if (cursor < css.length) out += css.slice(cursor);
    if (out !== css) styleEl.textContent = out;
  }

  // <image> references inside inline SVGs (avatars/art drawn as SVG
  // <image>) — inline or blank them like <img>s.
  for (const imgEl of Array.from(
    clone.querySelectorAll<SVGImageElement>("image"),
  )) {
    const href = imgEl.getAttribute("href") || imgEl.getAttribute("xlink:href");
    if (!href) continue;
    const abs = absolutizeToken(href);
    if (abs) {
      imgEl.removeAttribute("xlink:href");
      imgEl.setAttribute("href", await inline(abs));
    }
  }

  // ── Catch-all scrub ────────────────────────────────────────────────
  // The targeted passes above inline every raster they recognise, but a
  // single missed external reference (an SVG <use> sprite, an exotic
  // embed, a background on an attribute we did not predict) would taint
  // the canvas when Chrome rasterizes. Walk the whole clone one last
  // time and neutralize ANY remaining external raster reference. The
  // snapshot therefore physically cannot taint — it contains nothing
  // but inline data: rasters.
  for (const el of Array.from(clone.querySelectorAll("*"))) {
    for (const attr of ["src", "href", "poster", "xlink:href"]) {
      const raw = el.getAttribute(attr);
      if (!raw) continue;
      const abs = absolutizeToken(raw);
      if (abs) el.setAttribute(attr, TRANSPARENT_PIXEL);
    }
    const srcset = el.getAttribute("srcset");
    if (srcset) {
      const next: string[] = [];
      for (const part of srcset.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [urlPart, ...rest] = trimmed.split(/\s+/);
        const abs = absolutizeToken(urlPart);
        next.push([abs ? TRANSPARENT_PIXEL : urlPart, ...rest].join(" "));
      }
      el.setAttribute("srcset", next.join(", "));
    }
  }

  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  return new XMLSerializer().serializeToString(clone);
}

type CompositeProbeResult = {
  ok: boolean;
  /** Human-readable reason when the probe fails — surfaced to the user
   *  instead of the old canned "canvas would be tainted" message, so the
   *  real cause (load failure / blank render / genuine taint) is visible. */
  reason?: string;
};

/**
 * Probe whether composite (DOM) capture works in this browser: load one
 * foreignObject snapshot, draw it, and verify the canvas stays
 * origin-clean AND something was actually painted (covers browsers that
 * silently render foreignObject blank or taint the canvas). Called once
 * when composite mode starts — a tainted canvas would make
 * captureStream throw, so we fail loudly instead of recording black.
 *
 * TRANSPORT: the snapshot MUST be served as a data: URL. Blob: URLs are
 * NOT origin-clean here — drawing an SVG image loaded from a blob:
 * taints the canvas in Chrome (verified experimentally: identical
 * snapshot, data: draws clean, blob: throws SecurityError on
 * getImageData). The data: form is limited to roughly 2 MB per URL by
 * Chrome, so the recorder compacts the embedded CSS (comments removed,
 * newlines collapsed) and reports a size error rather than failing
 * silently if the encoded snapshot would still exceed the limit.
 */
async function probeComposite(
  container: HTMLElement,
  css: string,
  resolve: (src: string) => Promise<string | null>,
  width: number,
  height: number,
): Promise<CompositeProbeResult> {
  /** Load one SVG snapshot; true = it loaded (regardless of pixels). */
  const loadSnapshot = async (svgCss: string): Promise<boolean> => {
    const html = await serializeContainerClean(container, resolve, 12);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      // The page CSS is CSS, not XML — it can legally contain raw &
      // (e.g. content: 'R&D'), which would make the whole SVG unparseable
      // and fail the image load. CDATA protects it.
      `<style><![CDATA[${svgCss}]]></style>` +
      `<foreignObject width="${width}" height="${height}">${html}</foreignObject></svg>`;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    try {
      const img = new Image();
      await new Promise<void>((loadOk, loadFail) => {
        img.onload = () => loadOk();
        img.onerror = () => loadFail(new Error("load failed"));
        img.src = url;
      });
      return true;
    } catch {
      return false;
    }
  };

  try {
    const loaded = await loadSnapshot(css);
    if (!loaded) {
      // Classify: is the snapshot simply too large for a data: URL, or is
      // DOM capture unsupported? Retry with empty CSS — if that loads,
      // the (compacted) CSS was still too big.
      const bare = await loadSnapshot("");
      const approxKb = Math.round(css.length / 1024);
      return {
        ok: false,
        reason: bare
          ? `the DOM snapshot is too large to load (~${approxKb} KB of CSS) — DOM recording cannot be used on this page`
          : "the SVG snapshot failed to load — DOM capture appears unsupported in this browser",
      };
    }

    // Loaded — now verify it stays origin-clean AND actually paints.
    const html = await serializeContainerClean(container, resolve, 12);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<style><![CDATA[${css}]]></style>` +
      `<foreignObject width="${width}" height="${height}">${html}</foreignObject></svg>`;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    try {
      const img = new Image();
      await new Promise<void>((loadOk, loadFail) => {
        img.onload = () => loadOk();
        img.onerror = () => loadFail(new Error("load failed"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return { ok: false, reason: "a 2D canvas context is unavailable" };
      }
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, width, height).data;
      } catch {
        return {
          ok: false,
          reason: "the rendered snapshot tainted the canvas (an asset could not be inlined)",
        };
      }
      for (let i = 0; i < data.length; i += 997) {
        if (data[i] || data[i + 1] || data[i + 2]) return { ok: true };
      }
      return {
        ok: false,
        reason: "the snapshot rendered blank — DOM capture is not supported in this browser",
      };
    } catch {
      return {
        ok: false,
        reason: "the snapshot failed to load when rendered — the DOM is too large for DOM recording",
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "unknown snapshot error",
    };
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
  /** Page CSS with every url() inlined — the only CSS the snapshot uses. */
  private cssClean = "";
  private cssCachedAt = 0;
  /** Resolved raster cache (url → data URL | null), cleared per capture. */
  private imageDataUrlCache = new Map<string, Promise<string | null>>();

  /** Resolve an image URL to a data URL (cached for the whole capture). */
  private resolveImageDataUrl(src: string): Promise<string | null> {
    let pending = this.imageDataUrlCache.get(src);
    if (!pending) {
      pending = fetchImageAsDataUrl(src);
      this.imageDataUrlCache.set(src, pending);
      // Keep the cache bounded (avatars/emotes are stable per session).
      if (this.imageDataUrlCache.size > 120) {
        for (const key of this.imageDataUrlCache.keys()) {
          this.imageDataUrlCache.delete(key);
          if (this.imageDataUrlCache.size <= 80) break;
        }
      }
    }
    return pending;
  }

  /** Inline every url() token in the page CSS (styles, backgrounds,
   *  fonts) so the snapshot's <style> can never taint the canvas either.
   *  Also COMPACTS the CSS (comments stripped, line breaks collapsed to
   *  single spaces) — the compacted CSS is what the recorder embeds, so
   *  the snapshot's data: URL stays comfortably under Chrome's ~2 MB
   *  ceiling even on CSS-heavy pages. */
  private async sanitizeCssUrls(rawCss: string): Promise<string> {
    const css = rawCss
      ? rawCss
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\s*\n\s*/g, " ")
          .trim()
      : "";
    if (!css || !css.includes("url(")) return css;
    const regex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(css))) {
      out += css.slice(cursor, match.index);
      const abs = absolutizeToken(match[2]);
      out += abs
        ? `url(${(await this.resolveImageDataUrl(abs)) || TRANSPARENT_PIXEL})`
        : match[0];
      cursor = match.index + match[0].length;
    }
    if (cursor < css.length) out += css.slice(cursor);
    return out;
  }

  private startedAt = 0;
  private requesting = false;
  private result: RecordingResult | null = null;
  /** Auto-save filename requested for the current capture: when set, the
   *  finished recording is downloaded automatically as soon as it is
   *  finalised (used by the "stop & save on quit/leave" path). */
  private saveOnStopFilename: string | null = null;
  /** URL of the clip most recently handed to download() — guards against
   *  handing the same finished clip to the browser twice (e.g. leave
   *  auto-save after the game-end auto-download already fired). */
  private lastDownloadedUrl: string | null = null;
  /** True from the moment stop() is called on a live recorder until its
   *  queued onstop → finalize() has run. dispose() waits for finalize so
   *  the finished clip is never torn down before it is saved. */
  private finalizePending = false;
  /** True when the chunks were already saved synchronously (unload path);
   *  the queued finalize() then only releases resources instead of
   *  rebuilding (and re-revoking) the saved clip. */
  private finalizeSuppressed = false;

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
      // A fresh capture starts with a clean auto-save state and a fresh
      // raster cache (game session may show different avatars/emotes).
      this.lastDownloadedUrl = null;
      this.finalizeSuppressed = false;
      this.imageDataUrlCache.clear();
      this.cssClean = "";
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
      // fail loudly rather than record a broken/black video. The probe
      // runs against the SANITIZED snapshot (all rasters inlined), which
      // is exactly what the real frames will draw.
      if (mode === "composite") {
        this.cssCache = collectPageCss();
        this.cssClean = await this.sanitizeCssUrls(this.cssCache);
        this.cssCachedAt = Date.now();
        const probe = await probeComposite(
          container,
          this.cssClean,
          (src) => this.resolveImageDataUrl(src),
          64,
          64,
        );
        if (!probe.ok) {
          // Best compatible fallback: if a dominant canvas exists, use
          // canvas mode instead of giving up silently.
          const canvases = Array.from(container.querySelectorAll("canvas")).filter(
            (c) => c.width > 0 && c.height > 0,
          );
          if (canvases.length > 0) {
            this.sourceMode = "canvas";
          } else {
            this.error = `In-page DOM capture is not possible: ${probe.reason ?? "unknown reason"}`;
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
    // The recorder's onstop → finalize() event is queued asynchronously —
    // remember it is owed so dispose() does not tear down first.
    this.finalizePending = true;
    try {
      this.recorder.stop();
    } catch {
      // Already inactive — nothing to stop.
      this.finalizePending = false;
    }
    // finalize() runs from the recorder's onstop handler.
  }

  /**
   * Stop the capture and AUTO-DOWNLOAD the finished file as soon as it
   * is finalised. This is the "save on leave" path (user quit the game,
   * navigated away, hidden the tab): the download is triggered from the
   * recorder's own finalize handler, so it never depends on React state
   * or the exterior bar still being mounted.
   * @returns the filename used, or null when there was nothing to save.
   */
  stopAndSave(filenameBase = "grynd-creator-recording"): string | null {
    this.saveOnStopFilename = filenameBase;
    if (this.recorder && this.recorder.state !== "inactive") {
      this.stop();
      return null; // finalize() performs the download once the clip exists
    }
    // A stop was already requested and its finalize() is still owed (the
    // user pressed Stop & save, then left before the clip finalised) —
    // keep the auto-save filename so that finalize downloads the clip.
    if (this.finalizePending) return null;
    this.saveOnStopFilename = null;
    // Nothing live — save an already-finished clip, unless that exact
    // clip was already handed to the browser (game-end auto-download,
    // manual Stop & save, a previous leave event…).
    if (this.result && this.lastDownloadedUrl !== this.result.url) {
      return this.download(filenameBase);
    }
    return null;
  }

  /**
   * Leave/close path (pagehide / beforeunload): the page can be torn
   * down before MediaRecorder's async onstop → finalize() runs, so build
   * the file synchronously from the frames already captured and hand it
   * to the browser download manager right now. Falls back to the graceful
   * stopAndSave() when there is nothing to build yet.
   * @returns the filename used, or null when there was nothing to save.
   */
  stopAndSaveSync(filenameBase = "grynd-creator-recording"): string | null {
    const chunks = this.chunks.filter((c) => c.size > 0);
    const live = Boolean(this.recorder && this.recorder.state !== "inactive");
    if (chunks.length > 0 && !this.result) {
      const mimeType = this.recorder?.mimeType || pickMimeType() || "video/webm";
      const blob = new Blob(chunks, { type: mimeType });
      const previous = this.result;
      this.result = {
        blob,
        url: URL.createObjectURL(blob),
        mimeType,
        dimensions: this.dimensions,
        durationMs: Date.now() - this.startedAt,
      };
      if (previous) URL.revokeObjectURL(previous.url);
      // The clip is saved — a queued finalize() must only release
      // resources, never rebuild or re-download it.
      this.saveOnStopFilename = null;
      this.finalizeSuppressed = true;
      if (live) {
        this.finalizePending = true;
        try {
          this.recorder?.stop();
        } catch {
          // ignore
        }
      }
      return this.download(filenameBase);
    }
    return this.stopAndSave(filenameBase);
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
    // Remember this clip was handed to the browser so the save-on-leave
    // path never downloads the same result twice.
    this.lastDownloadedUrl = result.url;
    return filename;
  }

  /** Release every resource: animation, recorder, stream, canvases,
   *  snapshot image, chunks and object URLs. */
  dispose(): void {
    this.cancelAnimation();
    const hadLiveRecorder = Boolean(
      this.recorder && this.recorder.state !== "inactive",
    );
    if (hadLiveRecorder) {
      // Unmounted mid-recording (user left the game page): stop the
      // capture. Downloads are ALWAYS manual — nothing auto-downloads on
      // teardown; the clip is simply released with the page.
      this.finalizePending = true;
      try {
        this.recorder?.stop();
      } catch {
        // ignore
      }
    }
    if (this.finalizePending) {
      // stop() was just requested on a live recorder — its queued onstop
      // event (→ finalize) must run before resources are released,
      // otherwise the chunks are wiped mid-finalize. finalize() clears
      // finalizePending; this deferred teardown then completes the
      // cleanup.
      setTimeout(() => this.teardown(), 600);
      return;
    }
    this.teardown();
  }

  /** Full resource teardown (shared by every dispose path). */
  private teardown(): void {
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
    this.finalizePending = false;
    if (this.finalizeSuppressed) {
      // The chunks were already saved synchronously (unload path) — only
      // release the capture resources, keeping the saved result intact.
      this.finalizeSuppressed = false;
      this.stream?.getVideoTracks().forEach((t) => t.stop());
      this.stream = null;
      this.recorder = null;
      this.chunks = [];
      return;
    }
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
        // Auto-save requested (stop & save on quit/leave): hand the
        // finished clip straight to the browser download manager.
        if (this.saveOnStopFilename) {
          const base = this.saveOnStopFilename;
          this.saveOnStopFilename = null;
          if (this.result) this.download(base);
        }
      }
    } else {
      this.error = "Recording stopped before any frames were captured.";
      this.saveOnStopFilename = null;
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
  private async drawCompositeFrame(): Promise<void> {
    const container = this.container;
    const ctx = this.ctx;
    const output = this.output;
    if (!container || !ctx || !output) return;

    // Refresh the stylesheet cache periodically (dynamic style injection)
    // and inline its url()s so the snapshot's <style> never touches the
    // network either.
    if (Date.now() - this.cssCachedAt > 2000) {
      this.cssCache = collectPageCss();
      this.cssClean = await this.sanitizeCssUrls(this.cssCache);
      this.cssCachedAt = Date.now();
    }

    const cw = container.offsetWidth || 1;
    const ch = container.offsetHeight || 1;
    const fit = fitRect(cw, ch, output.width, output.height);

    let html: string;
    try {
      html = await serializeContainerClean(container, (src) =>
        this.resolveImageDataUrl(src),
      );
    } catch {
      // A serialization hiccup keeps the previous frame — never break
      // the recording loop over a snapshot.
      return;
    }

    // Transport: the snapshot MUST be a data: URL — Chrome taints the
    // canvas when an SVG image is drawn from a blob: URL (verified
    // experimentally), while the identical snapshot from a data: URL
    // draws clean. Every raster inside is already inlined as data: and
    // the CSS is compacted + CDATA-wrapped, keeping the URL well under
    // Chrome's ~2 MB data-URL limit.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">` +
      `<style><![CDATA[${this.cssClean}]]></style>` +
      `<foreignObject width="${cw}" height="${ch}">${html}</foreignObject></svg>`;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    // If the encoded snapshot would exceed Chrome's data-URL ceiling,
    // skip the frame (keep the previous one) rather than load a dead URL.
    if (url.length > 1_900_000) return;

    try {
      if (!this.snapshotImg) this.snapshotImg = new Image();
      const img = this.snapshotImg;
      img.src = url;
      if (img.decode) await img.decode();

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
    } catch {
      // A snapshot that fails to decode leaves the previous frame — do
      // not throw out of the loop.
    }
  }
}
