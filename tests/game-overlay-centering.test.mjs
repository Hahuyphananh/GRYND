/**
 * game-overlay-centering.test.mjs
 *
 * The in-game overlays a player reads mid-match — the turn banner, the CHECK
 * pill, the draw-offer card, the score explosion — are `fixed` elements centred
 * with `left-1/2 -translate-x-1/2 [-translate-y-1/2]`.
 *
 * That centring is DEAD whenever the same element is a framer-motion component
 * animating a transform (`y`, `scale`, `x`, `rotate`): motion writes the
 * `transform` property inline and, once the spring settles, leaves it as
 * `transform: none`. Either way the Tailwind utility is overridden, so the
 * overlay is laid out from `left: 50%` with no half-width pull-back. Measured in
 * a real browser while fixing this, a 182px banner came out at `left=640` on a
 * 1280px viewport and at `left=160..342` on a 320px one: off-centre everywhere,
 * and cut off the right of a narrow phone, because the page roots are
 * `overflow-x-clip`/`hidden` and never scroll to reveal it.
 *
 * The fix is to centre these overlays without a transform —
 * `inset-x-0 mx-auto w-fit` (plus a `max-w-[calc(100vw-1.5rem)]` cap, so a long
 * label such as an opponent's name cannot exceed the viewport) — which no inline
 * transform can clobber.
 *
 * Two things make this easy to get wrong when re-reading the source:
 *   • the animation is often supplied as a SPREAD (`{...turnBannerAnim}`), so
 *     the animated keys are not visible on the tag; the spread itself has to
 *     count as "this element animates its transform";
 *   • a file can hold several overlays, so asserting per FILE would pass as
 *     long as any one of them is fixed. These assertions are per overlay.
 *
 * `absolute` overlays are deliberately out of scope: they are positioned inside
 * their own parent, so a clobbered translate shifts them by their own half-size
 * rather than off the screen — a cosmetic offset, not the mobile bug guarded
 * here.
 *
 * Run:  node --test tests/game-overlay-centering.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = "src";

const walk = (dir) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|jsx)$/.test(full)) out.push(full.replace(/\\/g, "/"));
  }
  return out;
};

const files = walk(SRC).sort();

/**
 * Every `<motion.…>` opening tag in a source file, with its line, its
 * `className` (when literal) and whether it animates a transform.
 */
const motionTags = (source) => {
  const src = source.replace(/\r\n/g, "\n");
  const tags = [];
  for (const match of src.matchAll(/<motion\.[a-zA-Z]+[\s\S]{0,1200}?>/g)) {
    const tag = match[0];
    const className = tag.match(/className=\{?["`]([^"`]*)["`]/);
    tags.push({
      line: src.slice(0, match.index).split("\n").length,
      className: className ? className[1] : null,
      // A spread carries the animation object; explicit keys cover the inline
      // form. Only transform keys make motion write `transform`.
      animatesTransform:
        /\{\s*\.\.\.\s*[^}]*\}/.test(tag) ||
        /[{,\s](x|y|scale|rotate|scaleX|scaleY)\s*:/.test(tag),
    });
  }
  return tags;
};

test("no fixed, translate-centred motion overlay relies on a clobbered transform", () => {
  const offenders = [];
  for (const file of files) {
    for (const tag of motionTags(fs.readFileSync(file, "utf8"))) {
      const cls = tag.className;
      if (!cls) continue;
      if (!/\bfixed\b/.test(cls)) continue;
      if (!/\bleft-1\/2\b/.test(cls)) continue;
      if (!/-translate-[xy]-1\/2/.test(cls)) continue;
      if (!tag.animatesTransform) continue;
      offenders.push(`${file}:${tag.line} — ${cls.slice(0, 130)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "framer-motion overrides the Tailwind translate on these overlays, so they " +
      "draw a half-width right of centre and are clipped on a phone. Centre them " +
      "with `inset-x-0 mx-auto w-fit max-w-[calc(100vw-1.5rem)]` instead:\n" +
      offenders.join("\n"),
  );
});

test("every fixed overlay that animates its transform is centred by margin", () => {
  const offenders = [];
  for (const file of files) {
    for (const tag of motionTags(fs.readFileSync(file, "utf8"))) {
      const cls = tag.className;
      if (!cls || !/\bfixed\b/.test(cls) || !tag.animatesTransform) continue;
      if (!/\bleft-1\/2\b/.test(cls)) continue;
      const centredByMargin =
        /\binset-x-0\b/.test(cls) && /\bmx-auto\b/.test(cls) && /\bw-fit\b/.test(cls);
      if (!centredByMargin) {
        offenders.push(`${file}:${tag.line} — ${cls.slice(0, 130)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `uncentred fixed overlay(s):\n${offenders.join("\n")}`);
});

test("the in-game turn banners cap themselves to the viewport and shrink on a phone", () => {
  const banners = [
    "src/app/casino/chess/ai/ChessAIPageInner.tsx",
    "src/app/casino/chess-game/[gameId]/PageClient.jsx",
    "src/app/casino/dice-flush/PageClient.tsx",
    "src/app/casino/uno/game/[gameId]/PageClient.jsx",
  ];
  for (const file of banners) {
    const src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    // The label carries text as long as an opponent's name, so the banner needs
    // a real cap, not just `w-fit`.
    assert.match(
      src,
      /className="[^"]*\bmax-w-\[calc\(100vw-1\.5rem\)\]/,
      `${file} must cap its overlay to the viewport`,
    );
    // It shrinks on a phone and grows back at `sm`.
    assert.match(
      src,
      /text-center text-2xl font-black[^"]*sm:text-3xl/,
      `${file} must shrink the overlay label on a phone`,
    );
    assert.doesNotMatch(
      src,
      /className="[^"]*text-center text-3xl font-black/,
      `${file} must not keep the full-size label on a phone`,
    );
  }
});
