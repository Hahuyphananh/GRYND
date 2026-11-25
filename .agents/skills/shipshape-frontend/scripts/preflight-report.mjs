#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] || process.cwd());
const strict = process.argv.includes("--strict");
const ignored = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const uiExtensions = new Set([".css", ".scss", ".html", ".jsx", ".tsx", ".vue", ".svelte"]);
const checks = [];

if (!existsSync(target)) {
  console.error(`Path not found: ${target}`);
  process.exit(1);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    if (entry.isFile()) files.push(full);
  }
  return files;
}

function add(name, passed, detail) {
  checks.push({ name, passed, detail });
}

const files = walk(target);
const uiFiles = files.filter((file) => uiExtensions.has(path.extname(file)));
const combinedUi = uiFiles.map((file) => readFileSync(file, "utf8")).join("\n");
const packageFile = path.join(target, "package.json");

if (existsSync(packageFile)) {
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  const scripts = pkg.scripts || {};
  add("build script", Boolean(scripts.build), scripts.build || "missing");
  add("test script", Boolean(scripts.test), scripts.test || "missing");
  add("lint script", Boolean(scripts.lint), scripts.lint || "missing");
} else {
  add("package.json", false, "missing");
}

add("ui files", uiFiles.length > 0, `${uiFiles.length} file(s) scanned`);

if (uiFiles.length > 0) {
  add("focus-visible", /:focus-visible|\bfocusVisible\b/.test(combinedUi), "visible keyboard focus styles");
  add("reduced motion", /prefers-reduced-motion/.test(combinedUi), "reduced-motion media query");
  add("no transition all", !/transition\s*:\s*all\b/i.test(combinedUi), "specific transition properties");
  add("image alt", !/<img\b(?![^>]*\balt=)/i.test(combinedUi), "img tags include alt attributes");
  add("no placeholders", !/\b(lorem ipsum|TODO:|FIXME:)\b/i.test(combinedUi), "no obvious placeholder markers");
} else {
  add("ui-specific checks", true, "skipped because no UI source files were found");
}

const failed = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "PASS" : "WARN";
  console.log(`${mark} ${check.name} - ${check.detail}`);
}

if (failed.length) {
  console.log(`Preflight completed with ${failed.length} warning(s).`);
  if (strict) process.exit(1);
} else {
  console.log("Preflight completed without warnings.");
}
