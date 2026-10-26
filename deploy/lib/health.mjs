// deploy/lib/health.mjs
//
// The gate a release must pass before it is allowed to stay active.
//
// Uses the endpoints the app and realtime server already expose:
//   GET http://127.0.0.1:3000/api/health   → 200 {"ok":true,"db":"ok",…}  (503 when Postgres is down)
//   GET http://127.0.0.1:3001/health       → 200 {"ok":true,"service":"realtime-server",…}
//
// A 2xx status alone is not proof of health: the gate also validates the body
// (`ok === true`, and `db === "ok"` for the app). A proxy or a modified route
// that answers 200 while Postgres is unreachable must still fail the gate.
//
// Everything is bounded (connect/response deadline, byte cap, no redirects) so
// a half-started release cannot make the deploy tool hang.

import http from "node:http";

/** Single HTTP probe. Never throws; a failure is data. */
export function probeHttp({
  url,
  timeoutMs = 2_000,
  maxBytes = 4_096,
  expectStatus = 200,
  requireJson = false,
  requiredFields = null,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ url, ok: false, status: null, ms: 0, error: "invalid url", body: "" });
      return;
    }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname)) {
      // The gate only ever talks to this host. A remote probe would be a
      // health check of something we did not just start.
      resolve({ url, ok: false, status: null, ms: 0, error: `refusing non-loopback probe (${target.hostname})`, body: "" });
      return;
    }

    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        agent: false,
        headers: { accept: "application/json", "user-agent": "grynd-release-health/1" },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= maxBytes) chunks.push(chunk);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 512);
          const status = response.statusCode ?? 0;
          const statusOk = status === expectStatus;
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // Reported below when a JSON body is required.
          }

          // Validate the dependency result, not just the HTTP status. `db` is
          // required for the app because Postgres is the one dependency whose
          // failure means the release cannot serve requests.
          let bodyProblem = null;
          if (requireJson) {
            if (json === null || typeof json !== "object" || Array.isArray(json)) {
              bodyProblem = "expected a JSON object body";
            } else if (json.ok !== true) {
              bodyProblem = `body reported ok=${JSON.stringify(json.ok)}, expected true`;
            } else {
              for (const [field, expected] of Object.entries(requiredFields ?? {})) {
                if (json[field] !== expected) {
                  bodyProblem = `body reported ${field}=${JSON.stringify(json[field])}, expected ${JSON.stringify(expected)}`;
                  break;
                }
              }
            }
          } else if (json !== null && json.ok === false) {
            bodyProblem = "body reported ok:false";
          }

          resolve({
            url,
            ok: statusOk && bodyProblem === null,
            status,
            ms: Date.now() - startedAt,
            error: statusOk ? bodyProblem : `expected ${expectStatus}, got ${status}`,
            body,
            json,
          });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    request.on("error", (error) => {
      resolve({ url, ok: false, status: null, ms: Date.now() - startedAt, error: error.message, body: "" });
    });
    request.end();
  });
}

/** The two checks an activation must pass. */
export function defaultHealthTargets({ appPort = 3000, realtimePort = 3001, includeRealtime = true } = {}) {
  const targets = [
    {
      name: "app",
      url: `http://127.0.0.1:${appPort}/api/health`,
      expectStatus: 200,
      requireJson: true,
      // A 200 with db != "ok" is not a healthy app. The current endpoint also
      // returns 503 in that case; this keeps the gate safe if it ever doesn't.
      requiredFields: { db: "ok" },
    },
  ];
  if (includeRealtime) {
    targets.push({
      name: "realtime",
      url: `http://127.0.0.1:${realtimePort}/health`,
      expectStatus: 200,
      requireJson: true,
    });
  }
  return targets;
}

/**
 * Poll every target until all pass or the deadline expires.
 *
 * The app's /api/health answers 503 while Postgres is unreachable, so a DB
 * outage fails the gate. That is intentional: the result is recorded with the
 * dependency state, and the caller reverts to the previous known-good release
 * rather than leaving an unverified release active.
 */
export async function runHealthGate({
  targets,
  attempts = 12,
  intervalMs = 750,
  timeoutMs = 2_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  probe = probeHttp,
} = {}) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("runHealthGate needs targets");

  const history = [];
  let results = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    results = await Promise.all(
      targets.map(async (target) => {
        const result = await probe({
          url: target.url,
          expectStatus: target.expectStatus ?? 200,
          timeoutMs,
          requireJson: target.requireJson === true,
          requiredFields: target.requiredFields ?? null,
        });
        return { name: target.name, ...result };
      }),
    );
    history.push({ attempt, at: new Date().toISOString(), results: results.map(({ name, ok, status, ms, error }) => ({ name, ok, status, ms, error })) });
    if (results.every((result) => result.ok)) {
      return { ok: true, attempts: attempt, results, history };
    }
    if (attempt < attempts) await sleep(intervalMs);
  }

  return { ok: false, attempts, results, history };
}

/** Compact, log-safe rendering (no headers, no secrets). */
export function summarizeHealth(gate) {
  return {
    ok: Boolean(gate?.ok),
    attempts: gate?.attempts ?? 0,
    checks: (gate?.results ?? []).map((result) => ({
      name: result.name,
      ok: result.ok,
      status: result.status,
      ms: result.ms,
      error: result.error ?? null,
    })),
  };
}
