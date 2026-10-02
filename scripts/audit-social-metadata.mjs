// Audits every App Router page/layout for social-preview metadata
// (Open Graph + Twitter cards).
//
//   node scripts/audit-social-metadata.mjs
//
// Why this exists: Next.js does NOT deep-merge `openGraph` or `twitter` from
// layout into page. `resolveOpenGraph()` (next/dist/lib/metadata) builds a
// fresh object from the page's own `openGraph`, and the layout's value is
// replaced wholesale. So a page that sets `openGraph` without `images`
// silently loses the site-wide og:image and renders an imageless card, and a
// page-local `openGraph` that omits `title`/`siteName`/`url` drops those too.
//
// The audit parses each file with the TypeScript compiler API (no runtime
// import, so no DB/Clerk/env needed) and reports the gaps. It follows local
// `const` references and shorthand properties, so hoisting values out of the
// metadata object (the pattern used by the casino pages) is understood.
import ts from "typescript";
import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "src/app");

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Recursively collect App Router entry files (page/layout/not-found). */
async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collect(full)));
    } else if (/^(page|layout|not-found|global-error)\.(tsx|jsx|ts|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const propName = (node) =>
  node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ? node.name.text
    : null;

/** Find a property by name, including shorthand (`{ title }`). */
const getProp = (obj, name) => {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  return obj.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      propName(p) === name
  );
};

/** The expression a property resolves to. */
const propExpr = (prop) => {
  if (!prop) return null;
  return ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
};

const unwrap = (n) => {
  let cur = n;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
};

/** Top-level `const x = <expr>` in the file, so identifiers can be resolved. */
function collectConsts(sourceFile) {
  const map = new Map();
  const walk = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          map.set(d.name.text, d.initializer);
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);
  return map;
}

/** Resolve a node that evaluates to an image URL (string) into a path. */
function resolveImagePath(node, consts) {
  if (!node) return null;
  const n = unwrap(node);
  if (ts.isIdentifier(n)) {
    const value = consts.get(n.text);
    return value ? resolveImagePath(value, consts) : null;
  }
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isCallExpression(n)) {
    // e.g. ogImageUrl("/images/og/chess.jpg")
    return resolveImagePath(n.arguments[0], consts);
  }
  if (ts.isObjectLiteralExpression(n)) {
    return resolveImagePath(propExpr(getProp(n, "url")), consts);
  }
  return null;
}

/** Collect the paths from an `images:` property value. */
function imagePaths(imagesProp, consts) {
  if (!imagesProp) return [];
  const v = unwrap(propExpr(imagesProp));
  if (ts.isArrayLiteralExpression(v)) {
    return v.elements.map((e) => resolveImagePath(e, consts)).filter(Boolean);
  }
  return [resolveImagePath(v, consts)].filter(Boolean);
}

/** Find the `metadata` object literal, or generateMetadata's returned object. */
function findMetadataObject(sourceFile) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    // export const metadata = { ... }
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "metadata" && d.initializer) {
          let init = d.initializer;
          if (ts.isSatisfiesExpression(init) || ts.isAsExpression(init)) init = init.expression;
          if (ts.isObjectLiteralExpression(init)) {
            found = init;
            return;
          }
        }
      }
    }
    // export (async) function generateMetadata() { return { ... } }
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) &&
      /\bgenerateMetadata\b/.test(node.getText(sourceFile))
    ) {
      const search = (n) => {
        if (ts.isReturnStatement(n) && n.expression) {
          let expr = n.expression;
          while (
            ts.isParenthesizedExpression(expr) ||
            ts.isAsExpression(expr) ||
            ts.isAwaitExpression(expr)
          ) {
            expr = expr.expression;
          }
          if (ts.isObjectLiteralExpression(expr)) found = expr;
        }
        if (!found) ts.forEachChild(n, search);
      };
      ts.forEachChild(node, search);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

const fileExists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const files = (await collect(APP)).sort();
const rows = [];
let errorCount = 0;
let warnCount = 0;

// Pages with no openGraph of their own inherit the layout's block verbatim:
// the site-wide title AND the site-root og:url. Tracked for the summary.
const inheritors = [];

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const text = await readFile(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const meta = findMetadataObject(sourceFile);
  if (!meta) {
    // global-error / not-found legitimately carry no metadata.
    if (!/(global-error|not-found)\./.test(rel)) {
      rows.push({ rel, kind: "warn", problems: ["no metadata export found"] });
      warnCount++;
    }
    continue;
  }

  const consts = collectConsts(sourceFile);
  const problems = [];
  const og = getProp(meta, "openGraph");
  const tw = getProp(meta, "twitter");
  const ogObj = og && ts.isObjectLiteralExpression(unwrap(propExpr(og))) ? unwrap(propExpr(og)) : null;
  const twObj = tw && ts.isObjectLiteralExpression(unwrap(propExpr(tw))) ? unwrap(propExpr(tw)) : null;

  if (!ogObj) inheritors.push(rel);

  const ogImages = imagePaths(getProp(ogObj, "images"), consts);
  const twImages = imagePaths(getProp(twObj, "images"), consts);

  // 1. A page-local openGraph without images drops the layout's og:image, so
  //    Facebook/LinkedIn/WhatsApp cards render with no image at all.
  if (ogObj && !getProp(ogObj, "images")) {
    problems.push("openGraph set but no images → og:image is dropped entirely");
  }
  // 2. Same for twitter: the layout's twitter:image is replaced, not merged.
  if (twObj && !getProp(twObj, "images")) {
    problems.push("twitter set but no images → twitter:image is dropped");
  }
  // 3. og:url is NOT inherited: resolveOpenGraph() nulls it when absent, so a
  //    page-local openGraph without url emits no og:url at all.
  if (ogObj && !getProp(ogObj, "url")) {
    problems.push("openGraph without url → no og:url emitted for this page");
  }
  // 4. og:image set but no twitter block → twitter keeps the layout's banner
  //    image (and generic title), so the two cards disagree.
  if (ogObj && ogImages.length && !twObj) {
    problems.push("og:image is page-specific but twitter falls back to the site banner");
  }
  // 5. If both blocks exist, their titles should agree.
  if (getProp(ogObj, "title") && twObj && !getProp(twObj, "title")) {
    problems.push("openGraph.title set but twitter has no title (cards disagree)");
  }
  // 5b. Because openGraph is replaced wholesale, a page-local openGraph must
  //     re-declare the shared fields it wants or they are silently dropped.
  if (ogObj) {
    const missing = ["title", "description", "siteName", "locale", "type"].filter(
      (k) => !getProp(ogObj, k)
    );
    if (missing.length) {
      problems.push(`openGraph drops inherited ${missing.map((m) => `og:${m}`).join(", ")}`);
    }
  }

  // 6. Referenced local image must exist in public/.
  for (const p of [...ogImages, ...twImages]) {
    if (p.startsWith("/") && !(await fileExists(path.join(ROOT, "public", p)))) {
      problems.push(`image not found in public/: ${p}`);
    }
  }

  // 7. A twitter card with an image should declare its card type explicitly.
  const cardProp = getProp(twObj, "card");
  const cardExpr = cardProp ? unwrap(propExpr(cardProp)) : null;
  const cardValue = cardExpr && ts.isStringLiteral(cardExpr) ? cardExpr.text : null;
  if (twObj && twImages.length && !cardProp) {
    problems.push("twitter images set without an explicit card type");
  }

  const hasErrors = problems.some(
    (p) => p.includes("dropped") || p.includes("not found")
  );
  if (problems.length) {
    if (hasErrors) errorCount++;
    else warnCount++;
    rows.push({
      rel,
      kind: hasErrors ? "error" : "warn",
      og: ogImages.length ? ogImages.join(", ") : "—",
      tw: twImages.length ? twImages.join(", ") : cardValue || "—",
      problems,
    });
  }
}

// ---- Report ---------------------------------------------------------------
console.log(`\nSocial-preview metadata audit — ${files.length} App Router entry files\n`);
console.log("Files are ONLY listed when something is missing/inconsistent.\n");

for (const row of rows) {
  const tag =
    row.kind === "error"
      ? `${RED}ERROR${RESET}`
      : row.kind === "warn"
        ? `${YELLOW}WARN ${RESET}`
        : `${DIM}INFO ${RESET}`;
  console.log(`${tag}  ${row.rel}`);
  for (const p of row.problems) console.log(`        ${RED}•${RESET} ${p}`);
  console.log(`        ${DIM}og:image=${row.og}  twitter=${row.tw}${RESET}`);
}

console.log(
  `\n${DIM}Systemic: ${inheritors.length}/${files.length} files define no openGraph of` +
    ` their own, so they inherit the layout block verbatim — including the` +
    ` site-wide og:title and the site-root og:url. Acceptable if intended;` +
    ` page-specific cards must declare their own openGraph.${RESET}`
);

console.log(
  `\n${errorCount ? RED : GREEN}${errorCount} error(s)${RESET}, ` +
    `${warnCount ? YELLOW : GREEN}${warnCount} warning(s)${RESET} ` +
    `across ${files.length} files.`
);
console.log(
  `${DIM}ERROR = renders without any preview image (or a broken image path). ` +
    `WARN = inconsistent but still renders.${RESET}\n`
);

process.exitCode = errorCount > 0 ? 1 : 0;
