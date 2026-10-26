// deploy/staging/fixture/app/server.mjs
//
// A stand-in for `next start` that has the two properties activation depends on:
//
//   * every path it serves is resolved from process.cwd() at request time, so
//     it observes whatever `current` points at when the process starts;
//   * it exposes /api/health with the same contract as the real app
//     (200 {ok:true} healthy, 503 {ok:false} unhealthy).
//
// FIXTURE_HEALTH=fail makes it permanently unhealthy, which is how the staging
// simulation drives a failed activation and the automatic revert.

import { createServer } from "node:http";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);

// A release can be built unhealthy (health-mode.txt), which is how the
// simulation produces a genuinely bad release rather than a bad environment.
function mode() {
  if (process.env.FIXTURE_HEALTH) return process.env.FIXTURE_HEALTH;
  try {
    return readFileSync(path.join(process.cwd(), "health-mode.txt"), "utf8").trim() || "ok";
  } catch {
    return "ok";
  }
}

function buildId() {
  try {
    return readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const id = buildId();

  if (url.pathname === "/api/health") {
    const healthy = mode() !== "fail" && id !== null;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: healthy, db: healthy ? "ok" : "error", buildId: id }));
    return;
  }

  if (url.pathname === "/api/build-id") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ buildId: id, cwd: process.cwd(), realCwd: realpathSync(process.cwd()) }));
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    const file = path.join(process.cwd(), ".next", "static", path.basename(url.pathname));
    if (!existsSync(file)) {
      res.writeHead(404).end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(readFileSync(file));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><title>fixture</title><p id="build">${id ?? "no-build-id"}</p>`);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fixture app listening on 127.0.0.1:${PORT} build=${buildId()}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
