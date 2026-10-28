// tests/keno-pvp-page-init-order.test.mjs
//
// The Keno match page is a plain `.jsx` client component: `tsc` does not check
// it, and qa/keno-survival-check.mjs bundles only the browser side — so a
// temporal-dead-zone read during render is invisible to both.
//
// One shipped exactly that way. `usePracticePause({ enabled: Boolean(match?.isAi)
// && !isFinished })` sat ABOVE `const isFinished = …`. In a PvP match the left
// operand is false, so `&&` short-circuited and hid it; the moment a practice
// (AI) match's payload arrived — i.e. as soon as a player joined a free game —
// `!isFinished` threw `ReferenceError: Cannot access 'isFinished' before
// initialization` and src/app/error.tsx replaced the whole screen with
// "This screen hit a problem".
//
// These are source-order checks, which is the only way to catch the class:
// a value read by a hook call must be declared above that call.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PAGE_PATH = "src/app/casino/keno-pvp/[matchId]/PageClient.jsx";
const PAGE = fs.readFileSync(PAGE_PATH, "utf8");

const indexOfOrFail = (needle, label) => {
  const at = PAGE.indexOf(needle);
  assert.notEqual(at, -1, `${PAGE_PATH} no longer contains ${label}`);
  return at;
};

test("keno page: match status flags are declared before any hook reads them", () => {
  const pauseCall = indexOfOrFail("usePracticePause({", "the practice-pause hook call");

  for (const flag of ["isWaiting", "isReady", "isLive", "isFinished", "isCancelled"]) {
    const declaration = indexOfOrFail(`const ${flag} =`, `\`const ${flag}\``);
    assert.ok(
      declaration < pauseCall,
      `\`const ${flag}\` must be declared before usePracticePause() reads it — ` +
        "a later declaration is a temporal-dead-zone ReferenceError in a practice match",
    );
  }

  // The only thing that saved PvP matches was short-circuiting on `isAi`.
  assert.ok(
    PAGE.includes("enabled: Boolean(match?.isAi) && !isFinished,"),
    "the practice-pause gate must keep reading the AI flag first",
  );
});

test("keno page: every status flag is used only after its declaration", () => {
  const firstDecl = indexOfOrFail("const isWaiting =", "the status-flag block");
  for (const usage of ["!isFinished,", "isWaiting || isReady", "isFinished && showResult"]) {
    const at = PAGE.indexOf(usage);
    assert.ok(at > firstDecl, `\`${usage}\` is used before the status flags are declared`);
  }
});

test("keno page: the result modal owns its router", () => {
  const modalAt = indexOfOrFail("function ResultModal({", "ResultModal");
  const modal = PAGE.slice(modalAt);

  // `router` used to be a free variable here — `ResultModal` is a sibling of the
  // page component, not a child, so it does not close over the page's router.
  // Clicking "Back to lobby" on a practice result threw a ReferenceError.
  assert.match(
    modal,
    /const router = useRouter\(\);/,
    "ResultModal must call useRouter() itself",
  );
  assert.match(modal, /onReturnToLobby=/, "the lobby exit must still be wired");
});
