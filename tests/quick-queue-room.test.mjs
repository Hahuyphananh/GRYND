import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const controller = fs.readFileSync("src/components/lobby/PlatformQuickQueue.jsx", "utf8");
const provider = fs.readFileSync("src/context/SocketProvider.tsx", "utf8");
const publisher = fs.readFileSync("src/app/api/quick-queue/publish/route.ts", "utf8");

test("client joins the authenticated user Quick Queue room", () => {
  assert.match(controller, /const \{ socket, userId \} = useSocket\(\)/);
  assert.match(controller, /quick-queue:user:\$\{userId\}/);
  assert.match(controller, /socket\.emit\("join_room", \{ roomId \}\)/);
  assert.match(controller, /socket\.emit\("leave_room", \{ roomId \}\)/);
});

test("socket context exposes Clerk user identity", () => {
  assert.match(provider, /useAuth\(\)/);
  assert.match(provider, /userId/);
});

test("publisher targets the same user-specific room", () => {
  assert.match(publisher, /quick-queue:user:\$\{userId\}/);
});
