#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] || process.cwd());
const failOnWarnings = process.argv.includes("--fail-on-warnings");
const extensions = new Set([".css", ".scss", ".sass", ".html", ".jsx", ".tsx", ".vue", ".svelte"]);
const ignored = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const issues = [];

if (!existsSync(target)) {
  console.error(`Path not found: ${target}`);
  process.exit(1);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

function add(file, line, severity, message) {
  issues.push({
    file: path.relative(target, file) || path.basename(file),
    line,
    severity,
    message
  });
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

for (const file of walk(target)) {
  const text = readFileSync(file, "utf8");
  const patterns = [
    {
      regex: /transition\s*:\s*all\b/gi,
      severity: "P2",
      message: "Avoid transition: all; animate specific properties to prevent accidental layout motion."
    },
    {
      regex: /outline\s*:\s*none\b/gi,
      severity: "P1",
      message: "Outline removal can erase keyboard focus unless a visible focus style replaces it."
    },
    {
      regex: /font-size\s*:\s*[^;]*\bvw\b/gi,
      severity: "P2",
      message: "Viewport-scaled font sizes can break readability and text fit across devices."
    },
    {
      regex: /\b(lorem ipsum|TODO:|FIXME:)\b/gi,
      severity: "P3",
      message: "Placeholder text or unfinished markers remain in UI source."
    },
    {
      regex: /<img\b(?![^>]*\balt=)/gi,
      severity: "P1",
      message: "Image elements need alt text or an explicit decorative treatment."
    },
    {
      regex: /<button\b(?=[^>]*aria-label=["']\s*["'])/gi,
      severity: "P1",
      message: "Button has an empty aria-label."
    }
  ];

  for (const check of patterns) {
    for (const match of text.matchAll(check.regex)) {
      add(file, lineNumber(text, match.index ?? 0), check.severity, check.message);
    }
  }

  const colorMatches = text.match(/#[0-9a-f]{3,8}\b/gi) || [];
  const uniqueColors = new Set(colorMatches.map((color) => color.toLowerCase()));
  if (uniqueColors.size > 18) {
    add(file, 1, "P2", `Found ${uniqueColors.size} unique hex colors; consider role-based tokens.`);
  }

  if (statSync(file).size > 120_000) {
    add(file, 1, "P3", "Large UI file; consider splitting before component behavior becomes hard to review.");
  }
}

if (issues.length === 0) {
  console.log("Static UI audit found no heuristic issues.");
  process.exit(0);
}

console.log(`Static UI audit found ${issues.length} issue(s):`);
for (const issue of issues) {
  console.log(`${issue.severity} ${issue.file}:${issue.line} - ${issue.message}`);
}

if (failOnWarnings) process.exit(1);

