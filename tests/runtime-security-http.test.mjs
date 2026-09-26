import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.TEST_BASE_URL;

if (!BASE) {
  test(
    "runtime security tests skipped (set TEST_BASE_URL to run)",
    { skip: true },
    () => {},
  );
} else {
  test("HTTP authz: uno online matchmaking rejects unauthenticated request", async () => {
    const res = await fetch(`${BASE}/api/uno/join-online`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "join_or_create" }),
    });

    assert.equal(res.status, 401);
  });

  test("HTTP CSRF: strict high-risk endpoint blocks missing token", async () => {
    const res = await fetch(`${BASE}/api/tokens/add-funds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 10 }),
    });

    assert.equal(res.status, 403);
  });

  test("HTTP rate-limit: debug endpoint eventually returns 429", async () => {
    let got429 = false;
    for (let i = 0; i < 25; i += 1) {
      const res = await fetch(`${BASE}/api/debug-env`);
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }

    assert.equal(got429, true);
  });
}
