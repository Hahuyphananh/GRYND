import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/app/api/availability-alerts/route.ts", "utf8");

test("availability alerts API provides authenticated CRUD operations", () => {
  assert.match(source, /export async function GET/);
  assert.match(source, /export async function POST/);
  assert.match(source, /export async function PATCH/);
  assert.match(source, /await auth\(\)/);
});

test("disabling an alert is scoped to its owner", () => {
  assert.match(source, /eq\(availabilityAlerts\.userId, userId\)/);
  assert.match(source, /active: false/);
});

test("alert creation validates player and wait constraints", () => {
  assert.match(source, /minPlayerCount must be a positive integer/);
  assert.match(source, /maxWaitMs must be a positive integer/);
});
