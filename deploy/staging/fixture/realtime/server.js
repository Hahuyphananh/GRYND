// deploy/staging/fixture/realtime/server.js
//
// Stand-in for realtime-server/server.js. It reports the marker file it finds in
// its OWN cwd, so the simulation can prove the realtime process is running from
// `current/realtime` rather than from a stale release directory.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3001);
const MODE = process.env.FIXTURE_RT_HEALTH || "ok";

function marker() {
  try {
    return fs.readFileSync(path.join(process.cwd(), "marker.txt"), "utf8").trim();
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    const healthy = MODE !== "fail" && marker() !== null;
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: healthy, service: "realtime-server", marker: marker(), cwd: process.cwd() }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fixture realtime listening on 127.0.0.1:${PORT} marker=${marker()}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
