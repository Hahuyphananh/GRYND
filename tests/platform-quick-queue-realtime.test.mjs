import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
const lobby = fs.readFileSync("src/components/lobby/PvpLobby.jsx", "utf8");

test("Quick Queue controller listens for realtime assignment events", () => {
  assert.match(controller, /quick_queue:ready/);
  assert.match(controller, /quick-queue:availability/);
  assert.match(controller, /socket\.on/);
  assert.match(controller, /refresh\(\)/);
});

test("Quick Queue controller exposes notification state", () => {
  assert.match(controller, /const \[notification, setNotification\]/);
  // The controller exposes both the notification and the toggle it renders.
  assert.match(controller, /notification,/);
  assert.match(controller, /onToggle: toggle/);
});

test("shared lobby renders realtime Quick Queue notifications", () => {
  assert.match(lobby, /quickQueue\.notification/);
  assert.match(lobby, /role="status"/);
});
