/**
 * ui-primitives.test.mjs
 *
 * D2's contract, pinned at the source level: the six primitives exist, they
 * read the semantic layer and nothing else, and they cost no new dependency.
 *
 * The important assertion is the third one — every `var(--x)` a primitive
 * references must be DECLARED in globals.css. A primitive that quietly reads
 * an undeclared variable renders with no colour at all, which is exactly the
 * failure mode a design system is supposed to make impossible.
 *
 * Run: node --test tests/ui-primitives.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const GLOBALS = read("src/app/globals.css");
const PACKAGE = JSON.parse(read("package.json"));

const PRIMITIVES = [
  "PageHeader",
  "Surface",
  "Button",
  "StatTile",
  "Tabs",
  "EmptyState",
];

const path = (name) => `src/components/ui/${name}.tsx`;

test("all six primitives exist and are re-exported", () => {
  const barrel = read("src/components/ui/index.ts");
  for (const name of PRIMITIVES) {
    assert.ok(existsSync(path(name)), `${path(name)} is missing`);
    assert.match(
      barrel,
      new RegExp(`default as ${name}`),
      `${name} must be exported from src/components/ui`,
    );
  }
});

test("no primitive contains a literal colour", () => {
  for (const name of PRIMITIVES) {
    const source = read(path(name));
    const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(
      hex,
      [],
      `${name} carries ${hex.join(", ")} — a primitive must not own a colour`,
    );
    assert.equal(
      /rgba?\(/.test(source),
      false,
      `${name} composes an rgb()/rgba() value; the semantic layer owns colour`,
    );
  }
});

test("every token a primitive reads is declared in globals.css", () => {
  const used = new Set();
  for (const name of [...PRIMITIVES, "cx"]) {
    const file = name === "cx" ? "src/components/ui/cx.ts" : path(name);
    for (const match of read(file).matchAll(/var\((--[a-z0-9-]+)\)/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 10, "expected the primitives to read the semantic layer");

  const declared = new Set([...GLOBALS.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  for (const token of used) {
    assert.ok(declared.has(token), `${token} is read by a primitive but never declared`);
  }
});

test("the semantic layer declares the full Phase 1 token set", () => {
  const required = [
    "--bg-page",
    "--bg-surface",
    "--bg-panel",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--border-hairline",
    "--border-strong",
    "--accent",
    "--accent-fill",
    "--on-accent",
    "--state-win",
    "--state-loss",
    "--state-gold",
    "--focus-ring",
    "--shadow-raise",
    "--radius-surface",
  ];
  for (const token of required) {
    assert.match(
      GLOBALS,
      new RegExp(`^\\s*${token}:\\s*\\S`, "m"),
      `${token} is missing from the semantic layer`,
    );
  }
});

test("grounds are aliases, so light mode cannot drift from them", () => {
  // The three grounds and the primary ink must be `var(--gr-*)`, not values:
  // that is what lets light-theme.css re-point them without this file knowing.
  const aliases = {
    "--bg-page": "--gr-surface-page",
    "--bg-surface": "--gr-surface-raised",
    "--bg-panel": "--gr-surface-panel",
    "--text-primary": "--gr-ink",
    "--focus-ring": "--gr-focus-ring",
    "--border-hairline": "--gr-hairline",
  };
  for (const [alias, gameToken] of Object.entries(aliases)) {
    assert.match(
      GLOBALS,
      new RegExp(`^\\s*${alias}:\\s*var\\(${gameToken}\\)`, "m"),
      `${alias} must alias ${gameToken} rather than copy its value`,
    );
  }
});

test("no class-merge dependency was added", () => {
  const deps = { ...PACKAGE.dependencies, ...PACKAGE.devDependencies };
  for (const banned of ["clsx", "tailwind-merge", "class-variance-authority"]) {
    assert.equal(deps[banned], undefined, `${banned} is not needed — cx() covers the primitives`);
  }
});
