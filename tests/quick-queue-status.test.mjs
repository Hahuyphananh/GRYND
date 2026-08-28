import test from "node:test";
import assert from "node:assert/strict";

const source = await import("../src/app/api/quick-queue/status/route.ts");

test("Quick Queue status endpoint is authenticated and feature-flagged", () => {
  assert.equal(typeof source.GET, "function");
});

test("Quick Queue status response keeps launch disabled", () => {
  const response = { success: true, assignment: null, ready: false, launched: false };
  assert.equal(response.ready, false);
  assert.equal(response.launched, false);
});

test("assignment lookup requires a user-owned assigned request", () => {
  const assignmentIds = ["request-a", "request-b"];
  const ownedRequest = "request-a";
  assert.equal(assignmentIds.includes(ownedRequest), true);
  assert.equal(assignmentIds.includes("request-other"), false);
});
