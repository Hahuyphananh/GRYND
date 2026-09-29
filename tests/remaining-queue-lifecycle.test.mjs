import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for (const [name, path, gameKey] of [
  ["lane rush", "src/lib/lane-rush-duel/serverStore.js", "lane-rush-duel"],
  ["mini golf", "src/lib/mini-golf/serverStore.ts", "mini-golf"],
]) {
  test(`${name} imports the shared lifecycle adapter`, () => {
    const source = fs.readFileSync(path, "utf8");
    assert.match(source, /canonicalQueueLifecycle/);
    assert.match(source, new RegExp(`gameKey: "${gameKey}"`));
  });
}
