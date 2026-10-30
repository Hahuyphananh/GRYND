// scripts/compact-emote-assets.mjs
//
// Re-encodes the emote pins so they are safe to ship to a phone.
//
//   node scripts/compact-emote-assets.mjs                  # re-encode in place
//   node scripts/compact-emote-assets.mjs --dry-run        # report only
//   node scripts/compact-emote-assets.mjs --from <dir>     # read pristine sources
//
// The catalog shipped 15 animated Noto WebP files totalling ~6.6 MB, with a
// single pin at 886 KB and 47–101 frames each. The UI draws a pin at 24–40 px,
// so that was ~6.6 MB of network and decode work for a 32 px bubble.
//
// This script does NOT change the artwork. It keeps the same frames' timing
// (the `fps` filter resamples the timeline, so a pin still lasts as long as it
// did), the same loop, and the same file names / catalog keys, and only:
//   * caps the canvas at 128 px,
//   * thins frames to <= MAX_FPS so an animated WebP stays inside the budget,
//   * steps quality down until the pin fits BUDGET_BYTES.
//
// Dropping in genuinely new brand artwork needs no code change: replace
// public/emotes/<key>.webp (then run this), keeping the key.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public/emotes");

const TARGET_PX = 128;
const MAX_FPS = 10;
const BUDGET_BYTES = 60 * 1024;

// Quality/frame-rate ladder, tried in order until a pin fits the budget.
// `fps` resamples instead of truncating, so duration is preserved.
const LADDER = [
  { fps: 10, q: 58 },
  { fps: 10, q: 50 },
  { fps: 10, q: 42 },
  { fps: 8, q: 42 },
  { fps: 8, q: 32 },
  { fps: 6, q: 28 },
  { fps: 6, q: 22 },
  { fps: 5, q: 18 },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fromIndex = args.indexOf("--from");
const SRC_DIR = fromIndex > -1 ? path.resolve(args[fromIndex + 1]) : OUT_DIR;

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

async function probe(file) {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames,width,height",
    "-of",
    "default=noprint_wrappers=1",
    file,
  ]);
  const out = {};
  for (const line of stdout.trim().split(/\r?\n/)) {
    const [key, value] = line.split("=");
    out[key] = value;
  }
  return {
    frames: Number(out.nb_read_frames || 0),
    width: Number(out.width || 0),
    height: Number(out.height || 0),
  };
}

async function encode(source, target, { fps, q }) {
  await exec("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    source,
    "-vf",
    `fps=${fps},scale=${TARGET_PX}:${TARGET_PX}:flags=lanczos:force_original_aspect_ratio=decrease`,
    "-c:v",
    "libwebp",
    "-lossless",
    "0",
    "-q:v",
    String(q),
    "-compression_level",
    "6",
    "-loop",
    "0",
    "-an",
    "-map_metadata",
    "-1",
    target,
  ]);
}

await exec("ffmpeg", ["-version"]).catch(() => {
  console.error("ffmpeg is required to thin frames; install it and re-run.");
  process.exit(1);
});

const files = (await readdir(SRC_DIR)).filter((file) => file.endsWith(".webp")).sort();
const work = await mkdtemp(path.join(tmpdir(), "grynd-emotes-"));

let beforeTotal = 0;
let afterTotal = 0;
const overBudget = [];

console.log(
  `${"file".padEnd(15)} ${"frames".padStart(10)} ${"before".padStart(9)} ${"after".padStart(9)}  setting`,
);

for (const file of files) {
  const source = path.join(SRC_DIR, file);
  const before = (await stat(source)).size;
  const input = await probe(source);
  beforeTotal += before;

  let chosen = null;
  for (const candidate of LADDER) {
    const attempt = path.join(work, `${file}.${candidate.fps}.${candidate.q}.webp`);
    await encode(source, attempt, candidate);
    const size = (await stat(attempt)).size;
    if (size <= BUDGET_BYTES || candidate === LADDER[LADDER.length - 1]) {
      chosen = { ...candidate, attempt, size };
      break;
    }
  }

  const output = await probe(chosen.attempt);
  afterTotal += chosen.size;
  if (chosen.size > BUDGET_BYTES) overBudget.push(`${file} (${kb(chosen.size)})`);

  const framesNote = `${output.frames}/${input.frames}`;

  console.log(
    `${file.padEnd(15)} ${framesNote.padStart(10)} ${kb(before).padStart(9)} ${kb(
      chosen.size,
    ).padStart(9)}  ${chosen.fps}fps q${chosen.q}${chosen.size > BUDGET_BYTES ? "  OVER BUDGET" : ""}`,
  );

  if (output.frames < 2) {
    throw new Error(`${file} lost its animation (${output.frames} frame) — refusing to write it.`);
  }

  if (!dryRun) {
    await mkdir(OUT_DIR, { recursive: true });
    await copyFile(chosen.attempt, path.join(OUT_DIR, file));
  }
}

await rm(work, { recursive: true, force: true });

console.log(
  `\nTotal: ${kb(beforeTotal)} → ${kb(afterTotal)} across ${files.length} files${
    dryRun ? " (dry run, nothing written)" : ""
  }`,
);

if (overBudget.length) {
  console.warn(`\nOver ${kb(BUDGET_BYTES)}: ${overBudget.join(", ")}`);
  process.exitCode = 1;
}
