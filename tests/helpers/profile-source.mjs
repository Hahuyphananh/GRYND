// tests/helpers/profile-source.mjs
//
// ONE reader for the profile surface.
//
// The profile started as a single 2,790-line client component and a dozen
// suites read it by path with regexes and `slice(indexOf(...))` windows. That
// made a split impossible: moving a section into a module removed the string
// the test pinned, even though the page still rendered it.
//
// `readProfileSource()` returns the page PLUS every module extracted from it,
// concatenated in a stable order. A contract about what the profile renders or
// does therefore survives the code moving into `src/components/profil/`, while
// still failing when the behaviour is actually removed.
//
// What this deliberately does NOT do:
//   * it does not weaken any assertion — the same regexes still have to match;
//   * it does not include the route wrapper (`page.jsx`), which keeps its own
//     metadata / ad-wiring contracts;
//   * concatenation preserves each file's own text, so a `slice(indexOf(a),
//     indexOf(b))` window still works as long as `a` and `b` live in the same
//     file — which is the rule for extraction (move a block whole, not halves).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PROFILE_PAGE = "src/app/profil/PageClient.jsx";

// Directories that may contain modules extracted from the page. Every file is
// picked up automatically, so a future extraction needs no test edit.
const EXTRACTED_DIRS = ["src/components/profil", "src/app/profil"];

// Read on its own by the ad and banner suites; not part of the profile surface.
const EXCLUDED = new Set([PROFILE_PAGE, "src/app/profil/page.jsx"]);

const SOURCE_FILE = /\.(jsx?|tsx?)$/;

function toPosix(path) {
  return path.replace(/\\/g, "/");
}

/** Every extracted module currently on disk, sorted for a stable concat order. */
export function profileModulePaths() {
  const files = [];
  for (const dir of EXTRACTED_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
      const path = toPosix(join(dir, entry.name));
      if (!EXCLUDED.has(path)) files.push(path);
    }
  }
  return files.sort();
}

/**
 * The page and all of its extracted modules as one source string.
 * Line numbers are NOT stable across the join — assertions must match text,
 * never a line offset.
 */
export function readProfileSource() {
  return [PROFILE_PAGE, ...profileModulePaths()]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}
