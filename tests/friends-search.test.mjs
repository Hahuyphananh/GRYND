// tests/friends-search.test.mjs
//
// Regression tests for two connected bugs found on /profil:
//
//  1. "Add Friends" never returned anything. The route built its self-exclusion
//     as a nested `sql` fragment —
//         ${currentUserId ? sql`AND id != ${currentUserId}` : sql``}
//     — but `getNeonSql()` (src/db/neon.ts) is a plain tagged-template helper,
//     not Neon's nesting-capable one. Calling `sql` on a nested template
//     EXECUTES it (the `AND id != $1` query on its own → 42601 syntax error),
//     and the outer statement received a bare `$2` placeholder plus a Promise
//     as its parameter. Every search threw, the route answered 500, and the
//     page rendered the same empty state as "no user matches this name".
//
//  2. The two history panels were French-only hardcoded copy (`Historique des
//     Paris`, `Aucun achat trouvé`, …) with no entry in the app-wide text
//     bundle, so EN/ES users saw French.
//
// These tests are source contracts on purpose: the failure mode is a shape in
// the SQL template (not a value the query returns), and the translated copy
// must live in the shared bundle rather than in the page.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import { searchNameFor } from "../src/lib/searchName.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, "..", rel), "utf8");

/** Body of a file with `//` and block comments stripped, so a contract can be
 *  asserted against code and not against the comment that explains it. */
function code(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const SEARCH_ROUTE = "src/app/api/friends/search/route.js";
const PROFILE_PAGE = "src/app/profil/PageClient.jsx";

// ── 1. The search route builds valid SQL ────────────────────────────────

test("the search route never nests a `sql` fragment inside another one", () => {
  const src = code(SEARCH_ROUTE);

  // `${ ... sql` ... ` ... }` — the exact form that executed as its own query.
  assert.doesNotMatch(
    src,
    /\$\{[^}]*\bsql`/,
    "a nested `sql` fragment runs as a standalone query; use a separate branch",
  );
});

test("the route excludes yourself with a conditional statement, not a fragment", () => {
  const src = code(SEARCH_ROUTE);

  // Two statements: one with the exclusion, one without.
  assert.match(src, /const found = currentUserId\s*\?[\s\S]*?await sql`/);
  assert.match(src, /\?\s*await sql`[\s\S]*?AND id != \$\{currentUserId\}/);
  assert.match(src, /:\s*await sql`[\s\S]*?ORDER BY name ASC[\s\S]*?LIMIT 10/);
  // The filter can only be a template VALUE, never text spliced into the SQL.
  assert.equal(
    (src.match(/\$\{currentUserId\}/g) ?? []).length,
    1,
    "`currentUserId` must only appear as a bound parameter",
  );
});

test("the query still matches on the folded search_name with a name fallback", () => {
  const src = code(SEARCH_ROUTE);
  assert.match(
    src,
    /COALESCE\(NULLIF\(search_name, ''\), name\)/,
    "the legacy `name` fallback must survive for un-backfilled rows",
  );
  assert.match(src, /LIKE '%' \|\| \$\{queryString\} \|\| '%'/);
  assert.match(src, /const normalized = searchNameFor\(rawInput\)/);
});

test("a query that folds to nothing returns no users instead of everyone", () => {
  const src = code(SEARCH_ROUTE);
  assert.match(
    src,
    /if \(!normalized\) \{[\s\S]*?users: \[\][\s\S]*?\}/,
    "an all-whitespace query would otherwise become LIKE '%%'",
  );
  // …and the fold really can produce that empty key.
  assert.equal(searchNameFor("   "), "");
  assert.equal(searchNameFor("!!!"), "!!!");
});

// ── 2. /profil actually uses it ──────────────────────────────────────────

test("the add-friends button searches the typed value, not the click event", () => {
  const src = code(PROFILE_PAGE);
  assert.match(src, /onClick=\{\(\) => handleSearchFriends\(\)\}/);
  assert.doesNotMatch(
    src,
    /onClick=\{handleSearchFriends\}/,
    "passing the raw handler sends the React event as the query",
  );
  // The typed value is what reaches the API.
  assert.match(src, /handleSearchFriends\(friendSearch\)/);
  assert.match(src, /body: JSON\.stringify\(\{ name: normalized \}\)/);
});

test("a failed search is surfaced instead of looking like 'no matches'", () => {
  const src = code(PROFILE_PAGE);
  assert.match(
    src,
    /if \(!response\.ok \|\| !data\.success\) \{[\s\S]*?setFriendsStatus\(/,
    "a 500 must not render the same empty state as a real zero-result search",
  );
  assert.match(src, /Could not search users\. Please try again\./);
});

// ── 3. Both history panels are translated in EN / FR / ES ───────────────

const localeKeys = [
  "profile.betHistory.title",
  "profile.betHistory.date",
  "profile.betHistory.game",
  "profile.betHistory.stake",
  "profile.betHistory.result",
  "profile.betHistory.unknown",
  "profile.betHistory.won",
  "profile.betHistory.lost",
  "profile.betHistory.draw",
  "profile.betHistory.empty",
  "profile.purchaseHistory.title",
  "profile.purchaseHistory.date",
  "profile.purchaseHistory.tokens",
  "profile.purchaseHistory.pack",
  "profile.purchaseHistory.purchase",
  "profile.purchaseHistory.empty",
  "profile.tokens",
];

function resolve(locale, key) {
  return key.split(".").reduce((node, part) => node?.[part], locale);
}

for (const lang of ["en", "fr", "es"]) {
  test(`every history-panel key exists in \`${lang}\``, () => {
    const bundle = APP_TEXT_TRANSLATIONS[lang];
    assert.ok(bundle, `missing locale ${lang}`);
    for (const key of localeKeys) {
      const value = resolve(bundle, key);
      assert.equal(
        typeof value,
        "string",
        `${lang} is missing ${key} (got ${JSON.stringify(value)})`,
      );
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  });
}

test("the English and Spanish titles are not the French copy", () => {
  const at = (lang, key) => resolve(APP_TEXT_TRANSLATIONS[lang], key);
  const fr = at("fr", "profile.betHistory.title").toLowerCase();
  for (const lang of ["en", "es"]) {
    assert.notEqual(at(lang, "profile.betHistory.title").toLowerCase(), fr);
    assert.notEqual(
      at(lang, "profile.purchaseHistory.title").toLowerCase(),
      fr,
    );
    // Not just different words — actually the other language.
    assert.doesNotMatch(at(lang, "profile.betHistory.empty"), /Aucun/);
  }
  assert.equal(at("en", "profile.betHistory.empty"), "No bets found");
  assert.equal(at("es", "profile.betHistory.empty"), "No se encontraron apuestas");
  assert.equal(at("en", "profile.purchaseHistory.title"), "Token purchase history");
  assert.equal(
    at("es", "profile.purchaseHistory.title"),
    "Historial de compras de fichas",
  );
});

test("the history panels read their copy from the bundle", () => {
  const src = code(PROFILE_PAGE);
  for (const key of localeKeys) {
    assert.match(
      src,
      new RegExp(`t\\("${key.replace(/\./g, "\\.")}"`),
      `the page never renders ${key}`,
    );
  }
});

test("the French-only hardcoded copy is gone from the page", () => {
  const src = code(PROFILE_PAGE);
  for (const frenchOnly of [
    "Historique des Paris",
    "Historique des Achats de Jetons",
    "Jeu / Événement",
    "Aucun pari trouvé",
    "Aucun achat trouvé",
    "Forfait",
    "Jetons",
    "Gagné",
    "Perdu",
    "Égalité",
    "Inconnu",
  ]) {
    assert.ok(
      !src.includes(frenchOnly),
      `\`${frenchOnly}\` is still hardcoded — it must come from the bundle`,
    );
  }
});
