#!/usr/bin/env node
// scripts/export-portal.mjs
//
// Write the per-game portal exports: one folder per portal + game containing
// `index.html` (a full-viewport launcher framing the hosted game) and
// `manifest.json` (what the portal's submission form asks for).
//
// Usage:
//   npm run portal:export -- --game dominoes --portal itch --base-url https://www.grynd.example
//   npm run portal:export -- --all --portal crazygames --base-url https://www.grynd.example
//   npm run portal:export -- --all --base-url https://www.grynd.example --out portal-exports
//
// Output: <out>/<portal>/<gameKey>/{index.html,manifest.json}
//
// The game is NOT bundled: every GRYND game is server-authoritative (Postgres +
// API routes), so the export is a launcher for the deployed game plus the facts
// a portal needs. See docs/portal-export.md for what each portal requires.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PORTAL_EXPORT_GAMES,
  PORTAL_SLUGS,
  buildExportFiles,
  getPortalExportGame,
  getPortalSpec,
  isPortalSlug,
  normalizePortalBaseUrl,
} from "../src/lib/portal/catalog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `GRYND portal export

  --game <key>        export one game (${PORTAL_EXPORT_GAMES.map((g) => g.gameKey).join(", ")})
  --portal <slug>     target portal (${PORTAL_SLUGS.join(", ")}) — repeatable, default: all
  --all               export every game
  --base-url <url>    https origin the game is deployed at (required)
  --out <dir>         output directory (default: portal-exports)
  --dry-run           print what would be written, write nothing
  --help              this text
`;

/** Parse `--flag value` / `--flag=value` pairs, with `--portal` repeatable. */
export function parseArgs(argv) {
  const options = {
    game: null,
    portals: [],
    all: false,
    baseUrl: null,
    out: "portal-exports",
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [rawFlag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, null];
    const value = () => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) return null;
      i += 1;
      return next;
    };

    switch (rawFlag) {
      case "--game":
        options.game = value();
        break;
      case "--portal": {
        const portal = value();
        if (portal) options.portals.push(portal);
        break;
      }
      case "--base-url":
        options.baseUrl = value();
        break;
      case "--out":
        options.out = value() || options.out;
        break;
      case "--all":
        options.all = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

/**
 * Resolve the export plan: which (portal, game) pairs, from validated input.
 * Throws with a human message on anything ambiguous, so the CLI never writes a
 * half-right export.
 */
export function planExports(options) {
  const baseUrl = normalizePortalBaseUrl(options.baseUrl);
  if (!baseUrl) {
    throw new Error("--base-url must be an https origin, e.g. https://www.grynd.example");
  }

  const portals = options.portals.length ? options.portals : [...PORTAL_SLUGS];
  for (const portal of portals) {
    if (!isPortalSlug(portal)) {
      throw new Error(`Unknown portal "${portal}" (expected: ${PORTAL_SLUGS.join(", ")})`);
    }
  }

  let games;
  if (options.all) {
    games = PORTAL_EXPORT_GAMES.map((game) => game.gameKey);
  } else if (options.game) {
    if (!getPortalExportGame(options.game)) {
      throw new Error(
        `Unknown game "${options.game}" (expected: ${PORTAL_EXPORT_GAMES.map((g) => g.gameKey).join(", ")})`,
      );
    }
    games = [options.game];
  } else {
    throw new Error("Pass --game <key> or --all");
  }

  return { baseUrl, portals, games };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`✖ ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  let plan;
  try {
    plan = planExports(options);
  } catch (error) {
    console.error(`✖ ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const outRoot = resolve(process.cwd(), options.out);
  const generatedAt = new Date().toISOString();
  let written = 0;

  for (const portal of plan.portals) {
    const spec = getPortalSpec(portal);
    for (const gameKey of plan.games) {
      const files = buildExportFiles({
        gameKey,
        portal,
        baseUrl: plan.baseUrl,
        generatedAt,
      });
      if (!files) {
        console.error(`✖ could not build the ${portal}/${gameKey} export`);
        process.exitCode = 1;
        return;
      }

      const dir = join(outRoot, portal, gameKey);
      if (!options.dryRun) mkdirSync(dir, { recursive: true });

      for (const [name, contents] of Object.entries(files)) {
        const target = join(dir, name);
        if (options.dryRun) {
          console.log(`· would write ${target} (${contents.length} bytes)`);
        } else {
          writeFileSync(target, contents, "utf8");
          written += 1;
        }
      }

      console.log(
        `${options.dryRun ? "·" : "✔"} ${portal}/${gameKey} → ${plan.baseUrl}/play/${gameKey}` +
          (spec && spec.hosting === "upload-zip"
            ? " (this portal hosts the build itself — see manifest requirements)"
            : ""),
      );
    }
  }

  if (options.dryRun) {
    console.log("\nDry run: nothing was written.");
    return;
  }

  console.log(`\n${written} file(s) written under ${outRoot}`);
  console.log("Next: docs/portal-export.md lists what each portal still requires.");
}

// Only run when executed directly, so tests can import the helpers.
const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;

if (invokedDirectly) main();
