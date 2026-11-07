#!/usr/bin/env node
// scripts/lib/zip-read.mjs
//
// Reads and extracts the ZIPs this repository produces, with no dependency.
//
// Why a reader at all: the verifier must inspect the ARCHIVE, not the folder it
// was packed from. "index.html is at the root" and "the JS/CSS/images are all in
// there" are properties of the bytes a portal receives, and a packer bug is
// exactly the thing that makes the folder right and the archive wrong.
//
// Parsing the central directory also re-checks every entry's CRC and length, so
// a truncated download or a corrupted write fails loudly instead of shipping.
//
// Formats supported are the ones scripts/zip-portal-package.mjs writes:
// stored (0) and deflated (8). Anything else is refused rather than guessed at.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

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

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Parse a ZIP file into `{ path, bytes, entries }`, where each entry is
 * `{ name, size, method, data }`. Throws on anything that is not a sound
 * archive — including a CRC or length mismatch, which is a corrupt entry.
 */
export function readZip(file) {
  const buffer = readFileSync(file);

  // The end-of-central-directory record sits at the end, after an optional
  // comment of up to 64 KiB, so scan back that far for its signature.
  let end = -1;
  const floor = Math.max(0, buffer.length - 22 - 65535);
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL) {
      end = at;
      break;
    }
  }
  assert.ok(end >= 0, `${file}: not a ZIP file (no end-of-central-directory record)`);

  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryStart = buffer.readUInt32LE(end + 16);
  assert.ok(count > 0, `${file}: the archive is empty`);
  assert.ok(
    directoryStart + directorySize <= end,
    `${file}: the central directory lies outside the file (truncated archive?)`,
  );

  const entries = [];
  let at = directoryStart;
  for (let index = 0; index < count; index += 1) {
    assert.equal(
      buffer.readUInt32LE(at),
      CENTRAL_HEADER,
      `${file}: bad central-directory header at entry ${index}`,
    );
    const method = buffer.readUInt16LE(at + 10);
    const expectedCrc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);

    assert.equal(
      buffer.readUInt32LE(localOffset),
      LOCAL_HEADER,
      `${file}: ${name} has no local header`,
    );
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    assert.ok(
      method === 0 || method === 8,
      `${file}: ${name} uses compression method ${method}; only stored (0) and deflated (8) are supported`,
    );
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, size, `${file}: ${name} unpacked to ${data.length} bytes, not ${size}`);
    assert.equal(crc32(data), expectedCrc, `${file}: ${name} failed its CRC check`);

    entries.push({ name, size, method, data });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return { path: file, bytes: buffer.length, entries };
}

/** Write an already-parsed archive to a fresh directory. */
export function extractZip(archive, destination) {
  for (const entry of archive.entries) {
    assert.ok(
      !entry.name.startsWith("/") && !entry.name.includes(".."),
      `${archive.path}: refusing to extract the unsafe path "${entry.name}"`,
    );
    const target = join(destination, ...entry.name.split("/"));
    if (entry.name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  return destination;
}
