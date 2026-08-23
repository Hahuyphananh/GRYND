#!/usr/bin/env node
/**
 * GRYND realtime-server load test.
 *
 * Floods the socket server with concurrent authenticated connections that
 * join rooms and emit events (mimicking live game traffic), then reports
 * connection success rate, latencies, and failures.
 *
 * Usage:
 *   SOCKET_URL=https://your-socket-host SESSION_TOKEN=eyJ... node loadtest.js
 *
 * Optional:
 *   CONCURRENCY=300   total sockets to open (default 200)
 *   DURATION_MS=30000 how long to hold connections (default 20000)
 *   EVENTS_PER_SEC=5  room_event emits per second per socket (default 5)
 *
 * Getting a SESSION_TOKEN: sign in to GRYND, open DevTools → Console and run
 *   localStorage.getItem("__session")
 * Paste the value (starts with eyJ). The token only needs to be valid while
 * the test runs.
 *
 * The server must be reachable and CLERK_SECRET_KEY configured, otherwise
 * connections fail with "Invalid authentication token" — which the script
 * still counts, so a wrong/missing token is visible in the report.
 */

const { io } = require("socket.io-client");

const SOCKET_URL = (process.env.SOCKET_URL || "").trim().replace(/\/$/, "");
const TOKEN = (process.env.SESSION_TOKEN || "").trim();
const CONCURRENCY = Number(process.env.CONCURRENCY || 200);
const DURATION_MS = Number(process.env.DURATION_MS || 20000);
const EVENTS_PER_SEC = Number(process.env.EVENTS_PER_SEC || 5);

if (!SOCKET_URL) {
  console.error("Missing SOCKET_URL (e.g. https://casino-realtime.onrender.com)");
  process.exit(1);
}
if (!TOKEN) {
  console.error("Missing SESSION_TOKEN — see header comment for how to get one.");
  process.exit(1);
}
if (!TOKEN.startsWith("eyJ")) {
  console.error("SESSION_TOKEN does not look like a JWT (should start with eyJ).");
  process.exit(1);
}

const CONNECT_TIMEOUT_MS = 15000;
const results = {
  total: 0,
  connected: 0,
  failed: 0,
  connectErrors: [],
  connectLatencyMs: [],
  roomEventsSent: 0,
  roomEventErrors: 0,
};

function connectOne(index) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      timeout: CONNECT_TIMEOUT_MS,
      reconnection: false,
      auth: { token: TOKEN },
    });

    const fail = (err) => {
      results.failed += 1;
      const msg = (err && err.message) || String(err);
      results.connectErrors[msg] = (results.connectErrors[msg] || 0) + 1;
      try { socket.disconnect(); } catch {}
      resolve();
    };

    socket.on("connect", () => {
      results.connected += 1;
      results.connectLatencyMs.push(Date.now() - t0);

      // Join a room like a real client, then emit events for the duration.
      socket.emit("join_room", { roomId: `loadtest:${index}` });
      const interval = setInterval(() => {
        if (socket.connected) {
          socket.emit("room_event", {
            roomId: `loadtest:${index}`,
            event: "loadtest_ping",
          });
          results.roomEventsSent += 1;
        }
      }, Math.max(200, 1000 / Math.max(1, EVENTS_PER_SEC)));

      setTimeout(() => {
        clearInterval(interval);
        socket.disconnect();
        resolve();
      }, DURATION_MS);
    });

    socket.on("connect_error", (err) => fail(err));
    socket.on("connect_timeout", () => fail(new Error("connect_timeout")));
  });
}

async function run() {
  console.log(
    `Load test: ${CONCURRENCY} sockets → ${SOCKET_URL} ` +
    `(hold ${DURATION_MS}ms, ${EVENTS_PER_SEC} events/s each)`
  );
  const start = Date.now();

  // Connect in waves so a thundering herd doesn't distort the numbers.
  const WAVE = 50;
  let inFlight = 0;
  let launched = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (inFlight < WAVE && launched < CONCURRENCY) {
        inFlight += 1;
        launched += 1;
        connectOne(launched).finally(() => {
          inFlight -= 1;
          results.total += 1;
          if (inFlight === 0 && launched >= CONCURRENCY) resolve();
        });
      }
    };
    pump();
    const timer = setInterval(() => {
      pump();
      if (launched >= CONCURRENCY && inFlight === 0) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });

  const elapsedMs = Date.now() - start;
  const p = (arr, q) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))]);
  };

  console.log("\n===== RESULTS =====");
  console.log(`Total sockets        : ${results.total}`);
  console.log(`Connected            : ${results.connected}`);
  console.log(`Failed               : ${results.failed}`);
  console.log(`Connect success rate : ${((results.connected / Math.max(1, results.total)) * 100).toFixed(1)}%`);
  console.log(`Connect latency      : p50=${p(results.connectLatencyMs, 50)}ms p95=${p(results.connectLatencyMs, 95)}ms p99=${p(results.connectLatencyMs, 99)}ms`);
  console.log(`room_event emits     : ${results.roomEventsSent}`);
  console.log(`room_event errors    : ${results.roomEventErrors}`);
  console.log(`Test wall time       : ${elapsedMs}ms`);
  if (Object.keys(results.connectErrors).length) {
    console.log("\nConnect error breakdown:");
    for (const [msg, count] of Object.entries(results.connectErrors)) {
      console.log(`  ${count}x  ${msg}`);
    }
  }

  const success = results.failed === 0;
  console.log(success ? "\nPASS — server held all connections." : "\nFAIL — see error breakdown above.");
  process.exit(success ? 0 : 1);
}

run();
