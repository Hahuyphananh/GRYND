#!/usr/bin/env node
// scripts/zip-portal-package.mjs
//
// Zips a portal package so that index.html is at the archive ROOT.
//
// Written by hand because the machine may not have `zip` (this one does not),
// and because the layout guarantee is the whole point: a wrapper folder — the
// classic "solitaire-duel/solitaire-duel/index.html" mistake — is what stops a
// portal from finding the game. The file list here is built from paths relative
// to the package directory, so `index.html` can always only be at the top level.
//
// No dependencies: Node's zlib supplies the deflate stream and the repository
// supplies nothing else.
//
// The packing logic is exported for scripts/package-itch-solitaire.mjs, which
// needs the same guarantees under a different command name:
//
//   node scripts/zip-portal-package.mjs
//   node scripts/zip-portal-package.mjs --dir=dist/portal/solitaire-duel --out=dist/packages/solitaire-duel-itch.zip

import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ── CRC-32 (the ZIP checksum) ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS timestamp, the only format a ZIP stores. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// ── Collect the package's files, index.html first ────────────────────────
function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else found.push({ abs: full, name: relative(base, full).split(sep).join("/") });
  }
  return found;
}

/**
 * Pack `sourceDir` into `outFile`, `index.html` first.
 *
 * Refuses an output path inside the directory being packed (it would be zipped
 * half-written) and refuses a package with no root `index.html`.
 *
 * @returns {{ outFile: string, bytes: number, files: { name: string, size: number }[] }}
 */
export function zipDirectory(sourceDir, outFile) {
  const dir = resolve(sourceDir);
  const out = resolve(outFile);

  if (!statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }
  if (out === dir || out.startsWith(`${dir}${sep}`)) {
    throw new Error(`Refusing to write the archive inside the package it packs: ${out}`);
  }

  const files = walk(dir).sort((a, b) => {
    if (a.name === "index.html") return -1;
    if (b.name === "index.html") return 1;
    return a.name.localeCompare(b.name);
  });

  if (files[0]?.name !== "index.html") {
    throw new Error("Refusing to zip: the package has no index.html at its root.");
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const data = readFileSync(file.abs);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(file.name, "utf8");
    const { time, date } = dosStamp(statSync(file.abs).mtime);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...locals, ...centrals, end]);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, archive);

  return {
    outFile: out,
    bytes: archive.length,
    files: files.map((file) => ({ name: file.name, size: statSync(file.abs).size })),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const found = argv.find((entry) => entry.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
  };

  const dir = resolve(process.cwd(), option("dir", "dist/portal/solitaire-duel"));
  const out = resolve(process.cwd(), option("out", "dist/packages/solitaire-duel-itch.zip"));

  let result;
  try {
    result = zipDirectory(dir, out);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
  console.log(`${result.outFile.replace(process.cwd(), ".").replace(/\\/g, "/")}  ${kb(result.bytes)}\n`);
  for (const file of result.files) {
    console.log(`  ${kb(file.size).padStart(9)}  ${file.name}`);
  }
  console.log(`\n${result.files.length} file(s). index.html is at the archive root.`);
}
