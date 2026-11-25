/**
 * solitaire-board-drag-abort.test.mjs
 *
 * The board must survive a viewport change mid-drag.
 *
 * Android is configured with `configChanges` for orientation/screenSize, so a
 * rotation resizes the WebView instead of recreating it; `pointercancel` is
 * therefore not guaranteed. A drag left without a release shows a frozen ghost
 * and a held card until the next press.
 *
 * There is no DOM test harness in this repo, so this pins the seam at the
 * source level (the same approach as solitaire-duel-ui-contract.test.mjs):
 *   * the four surface-change signals are subscribed and unsubscribed;
 *   * the abort releases pointer capture, clears the selection and the ghost;
 *   * the abort proposes NO move and sends nothing to the server;
 *   * the abort does not fly the ghost home to now-stale coordinates.
 *
 * Run: node --import tsx --test tests/solitaire-board-drag-abort.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const BOARD = "src/components/solitaire-duel/SolitaireBoard.tsx";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Source with comments removed, so the prose above cannot satisfy an assertion. */
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const source = code(BOARD);

/** The body of the abort callback, or null when the seam is gone. */
function abortBody() {
  const start = source.indexOf("const abort = () => {");
  if (start === -1) return null;
  const end = source.indexOf("\n    };", start);
  return end === -1 ? null : source.slice(start, end);
}

test("the board subscribes to every surface change that can strand a drag", () => {
  for (const event of [
    'window.addEventListener("orientationchange", abort)',
    'window.addEventListener("resize", abort)',
    'window.addEventListener("blur", abort)',
    'document.addEventListener("visibilitychange", onVisibilityChange)',
  ]) {
    assert.ok(source.includes(event), `missing subscription: ${event}`);
  }
});

test("every subscription is removed on unmount", () => {
  for (const event of [
    'window.removeEventListener("orientationchange", abort)',
    'window.removeEventListener("resize", abort)',
    'window.removeEventListener("blur", abort)',
    'document.removeEventListener("visibilitychange", onVisibilityChange)',
  ]) {
    assert.ok(source.includes(event), `missing cleanup: ${event}`);
  }
});

test("a hidden document aborts, a visible one does not", () => {
  assert.ok(
    source.includes('if (document.visibilityState === "hidden") abort();'),
    "visibilitychange must abort only when the document is hidden",
  );
});

test("the abort releases the pointer, clears the held card and the ghost", () => {
  const body = abortBody();
  assert.ok(body, "the abort callback is missing");
  assert.match(body, /dragRef\.current = null/);
  assert.match(body, /releasePointerCapture\(session\.pointerId\)/);
  assert.match(body, /setSelection\(null\)/);
  assert.match(body, /setDragGhost\(null\)/);
});

test("the abort never proposes a move or talks to the server", () => {
  const body = abortBody();
  assert.ok(body, "the abort callback is missing");
  assert.ok(!body.includes("onMove("), "the abort must not propose a move");
  assert.ok(!body.includes("onInvalid("), "the abort must not report a rejection");
  assert.ok(!body.includes("fetch("), "the abort must not send a request");
  assert.ok(!body.includes("flyHome("), "the abort must not use stale viewport coordinates");
});

test("an aborted drag still swallows the click it would have produced", () => {
  const body = abortBody();
  assert.ok(body, "the abort callback is missing");
  assert.match(
    body,
    /if \(session\.active\) swallowNextClick\(\)/,
    "a drag that had started must consume its trailing click",
  );
});
