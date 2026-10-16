/**
 * Lint for the legal pages' "Last updated" date convention.
 *
 * Convention: every legal/policy page carries a "Last updated: <Month D,
 * YYYY>" line, and whenever its content changes the date must be toggled
 * (bumped) to TODAY — never left on a previous edit's date. Keeping all
 * legal pages on a single, current date makes it obvious to users and
 * store reviewers (App Store / Play data-safety forms) that the policies
 * are live and coherent.
 *
 * This script discovers every page client with a "Last updated" marker
 * (anything under src/app that renders one) and fails if:
 *   • a legal page is missing the marker,
 *   • the marker cannot be parsed as "<Month D, YYYY>",
 *   • or the date is not today's date (stale).
 *
 * Usage:
 *   node scripts/verify-legal-dates.mjs            # compare against today
 *   node scripts/verify-legal-dates.mjs --date 2026-09-04   # explicit date
 */

import fs from "node:fs";
import path from "node:path";

const MARKER = /Last updated:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/;

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// ── Expected date ─────────────────────────────────────────────────────
let expected = new Date();
const arg = process.argv[2];
if (arg && arg.startsWith("--date=")) {
  const [y, m, d] = arg.slice("--date=".length).split("-").map(Number);
  expected = new Date(y, (m || 1) - 1, d || 1);
}

// Strings like "September 4, 2026" — the canonical display format.
const MONTH_NAMES = Object.keys(MONTHS);
function formatDate(date) {
  const month = MONTH_NAMES[date.getMonth()];
  const capitalized = month[0].toUpperCase() + month.slice(1);
  return `${capitalized} ${date.getDate()}, ${date.getFullYear()}`;
}

function parseMarker(text) {
  const m = MARKER.exec(text);
  if (!m) return null;
  const [, monthName, dayStr, yearStr] = m;
  const month = MONTHS[monthName.toLowerCase()];
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (month === undefined || !Number.isInteger(day) || !Number.isInteger(year)) {
    return null;
  }
  return { year, month, day };
}

function sameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

// ── Discover legal pages ──────────────────────────────────────────────
const appRoot = path.join(process.cwd(), "src", "app");
function findLegalFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findLegalFiles(full, out);
      continue;
    }
    if (!/pageclient\.(jsx|tsx)$/i.test(entry.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    if (MARKER.test(text)) out.push(full);
  }
  return out;
}

const legalFiles = findLegalFiles(appRoot);
if (legalFiles.length === 0) {
  console.error("No legal pages with a \"Last updated\" marker found.");
  process.exit(1);
}

// ── Check ─────────────────────────────────────────────────────────────
const expectedLabel = formatDate(expected);
let failures = 0;

console.log(`Legal-page date convention (expected: ${expectedLabel})`);
console.log("");

for (const file of legalFiles.sort()) {
  const rel = path.relative(process.cwd(), file);
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseMarker(text);

  if (!parsed) {
    console.log(`✖ ${rel}: missing or unparseable "Last updated: <Month D, YYYY>" marker`);
    failures += 1;
    continue;
  }

  const markerDate = new Date(parsed.year, parsed.month, parsed.day);
  const ok = sameCalendarDay(markerDate, expected);
  console.log(
    `${ok ? "✔" : "✖"} ${rel}: ${formatDate(markerDate)}${ok ? "" : `  (expected ${expectedLabel})`}`,
  );
  if (!ok) failures += 1;
}

console.log("");
if (failures === 0) {
  console.log("All legal pages are current ✔");
} else {
  console.log(
    `${failures} legal page(s) need their "Last updated" date toggled to today ✖`,
  );
}
process.exit(failures === 0 ? 0 : 1);