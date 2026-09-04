// tests/creator-recorder.test.mjs
//
// Unit tests for the Creator Mode in-page recorder's stop-and-finalize
// path (src/lib/creator-mode/recorder.ts). The recorder is a browser
// module (MediaRecorder, canvas.captureStream, rAF, document), so the
// tests install minimal stubs for those globals BEFORE importing it,
// then drive a real CreatorRecorder through:
//
//   start()      → MediaRecorder captures (canvas mode)
//   stop()       → fake MediaRecorder flushes chunks + fires onstop
//   finalize()   → builds the Blob → result + "stopped" state
//   download()   → returns the grynd-{game}-{date}-{time} filename
//
// Plus the error branch (recording stopped before any frames) and the
// resource-lifecycle guarantee that a new capture revokes the previous
// result's object URL.

import test from "node:test";
import assert from "node:assert/strict";

// ── Browser API stubs (must exist before the recorder is imported) ──

const stubState = { emitDataAvailable: true };
let activeRecorder = null;

const downloadAnchors = [];
const revokedObjectUrls = new Set();
let objectUrlSeq = 0;

class FakeMediaRecorder {
  static isTypeSupported(type) {
    // Force the webm fallback so the mime-type walk (mp4 → vp9 → vp8 →
    // webm) is exercised deterministically: the recorder must land on
    // video/webm;codecs=vp9,opus.
    return type.startsWith("video/mp4") ? false : true;
  }

  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || "video/webm";
    this.state = "inactive";
    this._listeners = {};
    activeRecorder = this;
  }

  addEventListener(name, cb) {
    (this._listeners[name] ??= []).push(cb);
  }

  _fire(name, event) {
    for (const cb of this._listeners[name] ?? []) cb(event);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    // The real MediaRecorder emits a final dataavailable with the
    // remaining buffer, then onstop (which the recorder wires to
    // finalize). In no-chunks mode (error path) only onstop fires.
    if (stubState.emitDataAvailable) {
      this._fire("dataavailable", {
        data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }),
      });
    }
    this._fire("stop", {});
  }
}

const ctxStub = {
  fillStyle: "",
  fillRect() {},
  drawImage() {},
  getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }),
};

function makeCanvas(width, height) {
  return {
    width,
    height,
    getContext: () => ctxStub,
    captureStream: () => ({
      getAudioTracks: () => [],
      getVideoTracks: () => [],
    }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  };
}

/** A recording container whose whole area is one dominant <canvas> →
 *  canvas capture mode (no DOM serialization / probe needed). */
const recordingContainer = {
  isConnected: true,
  offsetWidth: 640,
  offsetHeight: 640,
  querySelectorAll: (sel) => (sel === "canvas" ? [makeCanvas(640, 640)] : []),
};

const storage = new Map();

globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  },
};

globalThis.document = {
  styleSheets: [],
  body: { appendChild() {} },
  createElement: (tag) => {
    if (tag === "canvas") return makeCanvas(640, 640);
    if (tag === "a") {
      const anchor = {
        href: "",
        download: "",
        click() {
          downloadAnchors.push({ href: this.href, download: this.download });
        },
        remove() {},
      };
      return anchor;
    }
    return {};
  },
};

let rafSeq = 0;
globalThis.requestAnimationFrame = () => ++rafSeq;
globalThis.cancelAnimationFrame = () => {};

// Node 24 has URL.createObjectURL/revokeObjectURL, but replace them so
// the test can assert exactly which URLs are created and revoked.
URL.createObjectURL = () => `blob:mock-${++objectUrlSeq}`;
URL.revokeObjectURL = (url) => {
  revokedObjectUrls.add(String(url));
};

// HTMLCanvasElement.prototype.captureStream is what
// isViewportRecordingSupported() checks for.
globalThis.HTMLCanvasElement = class HTMLCanvasElement {};
Object.defineProperty(globalThis.HTMLCanvasElement.prototype, "captureStream", {
  value: () => ({ getAudioTracks: () => [], getVideoTracks: () => [] }),
  configurable: true,
  writable: true,
});

globalThis.MediaRecorder = FakeMediaRecorder;

// Import the recorder AFTER the globals are installed (audioTap /
// audioSettings touch window at module scope).
const { CreatorRecorder, isViewportRecordingSupported } = await import(
  "../src/lib/creator-mode/recorder.ts"
);

function resetStubs() {
  stubState.emitDataAvailable = true;
  downloadAnchors.length = 0;
  revokedObjectUrls.clear();
  objectUrlSeq = 0;
}

test("isViewportRecordingSupported() reports true with the stubbed APIs", () => {
  assert.equal(isViewportRecordingSupported(), true);
});

test("start → stop finalises the recording into a downloadable blob", async () => {
  resetStubs();
  const states = [];
  const rec = new CreatorRecorder({ onStateChange: (s) => states.push(s) });

  const ok = await rec.start({
    container: recordingContainer,
    width: 1080,
    height: 1920,
    fps: 30,
  });

  assert.equal(ok, true);
  assert.equal(rec.state, "recording");
  assert.equal(rec.isRecording, true);
  assert.equal(rec.sourceModeUsed, "canvas");
  assert.ok(activeRecorder, "a MediaRecorder was created");
  assert.equal(activeRecorder.mimeType, "video/webm;codecs=vp9,opus");
  assert.equal(rec.dimensions.width, 1080);
  assert.equal(rec.dimensions.height, 1920);

  rec.stop();

  // finalize() runs synchronously from the fake onstop event.
  assert.equal(rec.state, "stopped");
  assert.equal(rec.isRecording, false);
  assert.ok(rec.lastResult, "a finished result exists");
  assert.equal(rec.lastResult.mimeType, "video/webm;codecs=vp9,opus");
  assert.equal(rec.lastResult.dimensions.width, 1080);
  assert.equal(rec.lastResult.dimensions.height, 1920);
  assert.match(rec.lastResult.url, /^blob:mock-/);
  assert.equal(typeof rec.lastResult.durationMs, "number");
  assert.ok(rec.lastResult.durationMs >= 0);
  assert.deepEqual(states, ["recording", "stopped"]);
});

test("download() triggers a browser download with the grynd filename", async () => {
  resetStubs();
  const rec = new CreatorRecorder();

  await rec.start({ container: recordingContainer, width: 1080, height: 1920 });
  rec.stop();

  const filename = rec.download("grynd-plinko");
  assert.ok(filename, "download returns a filename");
  assert.match(
    filename,
    /^grynd-plinko-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.webm$/,
  );
  assert.equal(downloadAnchors.length, 1);
  assert.equal(downloadAnchors[0].download, filename);
  assert.equal(downloadAnchors[0].href, rec.lastResult.url);

  // No result → download returns null and creates no anchor.
  resetStubs();
  const fresh = new CreatorRecorder();
  assert.equal(fresh.download("grynd-plinko"), null);
  assert.equal(downloadAnchors.length, 0);
});

test("finalize with no captured chunks reports an error, not a result", async () => {
  resetStubs();
  stubState.emitDataAvailable = false; // recorder stops before any frames

  const states = [];
  const rec = new CreatorRecorder({ onStateChange: (s) => states.push(s) });

  const ok = await rec.start({ container: recordingContainer, width: 320, height: 320 });
  assert.equal(ok, true);
  assert.equal(rec.state, "recording");

  rec.stop();

  // finalize reports the failure through the state-change callback and
  // the error field (the `state` getter only reflects the live
  // MediaRecorder, which is released once finalize completes).
  assert.equal(rec.lastResult, null);
  assert.match(rec.error, /frames/i);
  assert.deepEqual(states, ["recording", "error"]);
});

test("starting a new capture revokes the previous result's object URL", async () => {
  resetStubs();
  const rec = new CreatorRecorder();

  await rec.start({ container: recordingContainer, width: 1080, height: 1920 });
  rec.stop();
  const firstUrl = rec.lastResult.url;
  assert.equal(objectUrlSeq, 1);

  // Second capture: the previous result must be released so object URLs
  // never accumulate.
  const ok = await rec.start({ container: recordingContainer, width: 1080, height: 1920 });
  assert.equal(ok, true);
  assert.ok(revokedObjectUrls.has(firstUrl), "previous result URL revoked");
  assert.equal(rec.state, "recording");

  rec.stop();
  assert.equal(rec.state, "stopped");
  assert.equal(objectUrlSeq, 2);
  assert.notEqual(rec.lastResult.url, firstUrl);
});

test("stop() with nothing recording is a harmless no-op", () => {
  resetStubs();
  const rec = new CreatorRecorder();
  assert.doesNotThrow(() => rec.stop());
  assert.equal(rec.state, "idle");
  assert.equal(rec.lastResult, null);
});