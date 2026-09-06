import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertChatMessage } from "../src/lib/chatMessageList.js";

// Full enriched row as returned by POST /api/chat/messages and forwarded via
// the socket `chat:updated` broadcast.
function fullMessage(overrides = {}) {
  return {
    id: 1,
    roomType: "global",
    roomId: "main-lobby",
    clerkId: "user_1",
    displayName: "Ada",
    iconKey: "cat",
    content: "hello",
    isDeleted: false,
    deletedAt: null,
    deletedByClerkId: null,
    createdAt: "2026-09-06T10:00:00.000Z",
    equippedTitle: "Master",
    streakTitle: null,
    premium: true,
    premiumTitle: "GRYND+ Elite",
    chatColor: "#ff0000",
    ...overrides,
  };
}

// Partial row as delivered by the Supabase Realtime Postgres-Changes feed.
function realtimeRow(overrides = {}) {
  return {
    id: 1,
    roomType: "global",
    roomId: "main-lobby",
    clerkId: "user_1",
    displayName: "Ada",
    content: "hello",
    isDeleted: false,
    createdAt: "2026-09-06T10:00:00.000Z",
    ...overrides,
  };
}

test("appends a new message to an empty list", () => {
  const result = upsertChatMessage([], fullMessage({ id: 1 }));
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
  assert.equal(result[0].content, "hello");
});

test("appends a newer message after existing ones, keeping render order", () => {
  const existing = [fullMessage({ id: 1, createdAt: "2026-09-06T10:00:00.000Z" })];
  const result = upsertChatMessage(
    existing,
    fullMessage({ id: 2, createdAt: "2026-09-06T10:01:00.000Z" }),
  );
  assert.deepEqual(
    result.map((m) => m.id),
    [1, 2],
  );
});

test("out-of-order arrival is re-sorted by createdAt", () => {
  const existing = [fullMessage({ id: 2, createdAt: "2026-09-06T10:01:00.000Z" })];
  const result = upsertChatMessage(
    existing,
    fullMessage({ id: 1, createdAt: "2026-09-06T10:00:00.000Z" }),
  );
  assert.deepEqual(
    result.map((m) => m.id),
    [1, 2],
  );
});

test("upserting the same id replaces the row", () => {
  const existing = [fullMessage({ id: 1, content: "old" })];
  const result = upsertChatMessage(existing, fullMessage({ id: 1, content: "new" }));
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "new");
});

test("a full row upgrades a partial realtime row already in the list", () => {
  const existing = [realtimeRow({ id: 1 })];
  const result = upsertChatMessage(existing, fullMessage({ id: 1 }));
  assert.equal(result.length, 1);
  assert.equal(result[0].iconKey, "cat");
  assert.equal(result[0].premium, true);
  assert.equal(result[0].equippedTitle, "Master");
  assert.equal(result[0].chatColor, "#ff0000");
});

test("a partial realtime row never clobbers richer fields when the full row arrived first", () => {
  const existing = [fullMessage({ id: 1 })];
  const result = upsertChatMessage(existing, realtimeRow({ id: 1 }));
  assert.equal(result.length, 1);
  assert.equal(result[0].iconKey, "cat");
  assert.equal(result[0].premium, true);
  assert.equal(result[0].equippedTitle, "Master");
  assert.equal(result[0].chatColor, "#ff0000");
});

test("a partial realtime row still updates the fields it does carry", () => {
  const existing = [fullMessage({ id: 1, content: "old" })];
  const result = upsertChatMessage(
    existing,
    realtimeRow({ id: 1, content: "updated in place" }),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "updated in place");
});

test("a moderation patch marks the message deleted without losing other fields", () => {
  const existing = [fullMessage({ id: 1 })];
  const result = upsertChatMessage(existing, { id: 1, isDeleted: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].isDeleted, true);
  assert.equal(result[0].content, "hello");
  assert.equal(result[0].createdAt, "2026-09-06T10:00:00.000Z");
  assert.equal(result[0].iconKey, "cat");
});

test("an unknown moderation patch id is appended", () => {
  const existing = [fullMessage({ id: 1 })];
  const result = upsertChatMessage(existing, { id: 99, isDeleted: true });
  assert.equal(result.length, 2);
  assert.equal(result[1].id, 99);
  assert.equal(result[1].isDeleted, true);
});

test("undefined fields never overwrite existing values", () => {
  const existing = [fullMessage({ id: 1 })];
  const result = upsertChatMessage(existing, {
    id: 1,
    content: undefined,
    equippedTitle: undefined,
  });
  assert.equal(result[0].content, "hello");
  assert.equal(result[0].equippedTitle, "Master");
});

test("list is capped at 75 messages, dropping the oldest", () => {
  const existing = Array.from({ length: 75 }, (_, i) =>
    fullMessage({
      id: i + 1,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  const result = upsertChatMessage(
    existing,
    fullMessage({ id: 100, createdAt: "2026-01-01T00:01:16.000Z" }),
  );
  assert.equal(result.length, 75);
  assert.equal(result[0].id, 2);
  assert.equal(result[75 - 1].id, 100);
});

test("a full row that arrives late stays within the cap after upgrade", () => {
  const existing = Array.from({ length: 75 }, (_, i) =>
    realtimeRow({
      id: i + 1,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
  const result = upsertChatMessage(existing, fullMessage({ id: 75 }));
  assert.equal(result.length, 75);
  assert.equal(result[75 - 1].iconKey, "cat");
});

test("null or missing rows are ignored", () => {
  const existing = [fullMessage({ id: 1 })];
  assert.equal(upsertChatMessage(existing, null), existing);
  assert.equal(upsertChatMessage(existing, undefined), existing);
  assert.equal(upsertChatMessage(existing, { content: "no id" }), existing);
});

test("does not mutate the input list", () => {
  const existing = [fullMessage({ id: 1 })];
  const snapshot = JSON.stringify(existing);
  upsertChatMessage(existing, fullMessage({ id: 2 }));
  assert.equal(JSON.stringify(existing), snapshot);
});