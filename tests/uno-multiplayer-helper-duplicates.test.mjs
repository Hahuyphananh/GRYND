import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const unoPagePath = path.join(process.cwd(), 'src/app/casino/uno/page.jsx');
const source = fs.readFileSync(unoPagePath, 'utf8');

const helperNames = [
  'fetchUnoMultiplayerPublicGames',
  'resetUnoMultiplayerLobby',
  'createUnoMultiplayerTable',
  'joinUnoPublicTable',
  'addUnoMultiAiToSeat',
  'startUnoMultiplayerGame',
];

for (const helper of helperNames) {
  test(`UNO multiplayer helper is declared once: ${helper}`, () => {
    const re = new RegExp(`const\\s+${helper}\\s*=`, 'g');
    const matches = source.match(re) ?? [];
    assert.equal(
      matches.length,
      1,
      `Expected one declaration for ${helper}, found ${matches.length}. This can break Next.js build.`
    );
  });
}
