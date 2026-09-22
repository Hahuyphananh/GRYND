// tests/profil-page-i18n.test.mjs
//
// /profil is the last page that still carried hardcoded copy: some of it
// English ("Add Friends", "Danger Zone: Delete Account"), some French
// ("Infos Personnelles", "Solde de Tokens", "Membre depuis"). With no entry in
// the app-wide bundle, an English or Spanish player saw whichever language the
// string happened to be written in.
//
// The page now resolves every label through `t("profile.*")`. These contracts
// keep it that way:
//
//   1. no user-visible text node is hardcoded in the JSX any more;
//   2. every `profile.*` key the page asks for exists in EN, FR and ES (a
//      missing key silently renders the English fallback, which is exactly the
//      bug this replaced);
//   3. the page is wired to the language context.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = "src/app/profil/PageClient.jsx";
const src = readFileSync(join(here, "..", PAGE_PATH), "utf8");

function resolve(locale, key) {
  return key.split(".").reduce((node, part) => node?.[part], locale);
}

// Every key the page pulls, in source order.
const usedKeys = [
  ...new Set(
    [...src.matchAll(/\bt\(\s*"(profile\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]),
  ),
];

test("the profile page resolves its copy through the language context", () => {
  assert.match(src, /import \{ useTranslation \} from "\.\.\/\.\.\/hooks\/useTranslation"/);
  assert.match(src, /const \{ t \} = useTranslation\(\)/);
  assert.ok(
    usedKeys.length >= 100,
    `expected the page to use the bundle everywhere, found ${usedKeys.length} keys`,
  );
});

test("every profile key the page uses exists in EN, FR and ES", () => {
  assert.ok(usedKeys.length > 0);
  for (const lang of ["en", "fr", "es"]) {
    const bundle = APP_TEXT_TRANSLATIONS[lang];
    assert.ok(bundle, `missing locale ${lang}`);
    for (const key of usedKeys) {
      const value = resolve(bundle, key);
      assert.equal(
        typeof value,
        "string",
        `${lang} is missing ${key} — the page would silently fall back`,
      );
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test("the French-only and English-only labels are all in the bundle now", () => {
  // One representative per section, EN + FR + ES. If a section loses its
  // translations this fails with the section name.
  const sections = {
    "personal info": ["info.title", "info.settings", "info.memberSince", "info.unknownUser"],
    balance: ["balance.title", "balance.amount"],
    battlepass: ["battlepass.title", "battlepass.level", "battlepass.earn"],
    "grynd+": ["membership.title", "membership.active", "membership.resetDone"],
    customization: ["customization.title", "customization.accent"],
    emotes: ["emotes.title", "emotes.manage"],
    titles: ["titles.title", "titles.tabStreak", "titles.lockedSecret"],
    prestige: ["titles.prestigeBadge", "titles.showPrestige", "titles.prestigeLocked"],
    referral: ["referral.title", "referral.copy", "referral.redeemed"],
    friends: ["friends.addTitle", "friends.title", "friends.noInvites", "friends.spectate"],
    statistics: ["stats.title"],
    danger: ["danger.title", "danger.confirm"],
    "edit popup": ["edit.title", "edit.icon", "edit.frame", "edit.close"],
    "level up": ["levelUp.title", "levelUp.close"],
  };

  for (const [section, keys] of Object.entries(sections)) {
    for (const key of keys) {
      const full = `profile.${key}`;
      assert.ok(
        usedKeys.includes(full),
        `the ${section} section no longer renders profile.${key}`,
      );
      for (const lang of ["en", "fr", "es"]) {
        const value = resolve(APP_TEXT_TRANSLATIONS[lang], full);
        assert.ok(
          typeof value === "string" && value.length > 0,
          `${lang} lost profile.${key} (${section})`,
        );
      }
    }
  }
});

test("no user-visible text node is hardcoded in the page", () => {
  const offenders = [];
  src.split(/\r?\n/).forEach((line, index) => {
    const cleaned = line
      .replace(/className=\{[^}]*\}/g, "")
      .replace(/className="[^"]*"/g, "");
    const match = cleaned.match(/>[A-Za-z][A-Za-z0-9 ,.'’:/!?()&%+-]{2,}</);
    if (match) offenders.push(`${index + 1}: ${match[0]}`);
  });
  assert.deepEqual(
    offenders,
    [],
    "these text nodes bypass the bundle — wrap them in t(...)",
  );
});

test("the French-only copy that used to be hardcoded is gone", () => {
  for (const gone of [
    "Chargement...",
    "Connectez-vous pour voir votre profil",
    "Infos Personnelles",
    "Solde de Tokens",
    "Membre depuis",
    "Erreur lors du chargement des données",
  ]) {
    assert.ok(
      !src.includes(gone),
      `\`${gone}\` is still hardcoded — it must come from the bundle`,
    );
  }
});
