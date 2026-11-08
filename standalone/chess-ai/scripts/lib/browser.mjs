// standalone/chess-ai/scripts/lib/browser.mjs
//
// The Chrome/CDP plumbing the chess QA scripts share: a static server for a
// built folder, a headless Chrome, and one page with evaluate/poll helpers.
// Node only — no Playwright, no test framework.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export function findChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  assert.ok(found, "Chrome not found — set CHROME_PATH to a Chrome/Chromium binary");
  return found;
}

/** Serve one built folder on a random localhost port. */
export async function serveDirectory(dir) {
  const root = resolve(dir);
  assert.ok(existsSync(root), `no built folder at ${root}`);

  const server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const safe = normalize(requested).replace(/^[/\\]+/, "");
    let file = join(root, safe || "index.html");
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** Launch headless Chrome and resolve its DevTools browser endpoint. */
export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), "chess-ai-chrome-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-client-side-phishing-detection",
      "--disable-domain-reliability",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--metrics-recording-only",
      "--no-pings",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  const browserWs = await new Promise((done, fail) => {
    let buffered = "";
    const timer = setTimeout(
      () => fail(new Error("Chrome did not report a DevTools endpoint")),
      25_000
    );
    chrome.stderr.on("data", (chunk) => {
      buffered += chunk.toString();
      const found = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    chrome.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Chrome exited before it was ready (code ${code})`));
    });
  });

  return {
    ws: browserWs,
    async close() {
      chrome.kill();
      await sleep(120);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* tmp profile */
      }
    },
  };
}

/** Attach to the browser's first page target. */
export async function openPage(browserWs) {
  const port = new URL(browserWs).port;
  let target = null;
  for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json()
    );
    target = targets.find((entry) => entry.type === "page");
    if (!target) await sleep(100);
  }
  assert.ok(target, "no page target exposed by Chrome");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", () => fail(new Error("CDP socket failed")), { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const requests = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      settle?.(message);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(
        message.params?.exceptionDetails?.exception?.description ?? "uncaught exception"
      );
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      consoleErrors.push(
        (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ")
      );
    }
    if (message.method === "Network.requestWillBeSent") {
      requests.push(message.params?.request?.url ?? "");
    }
  });

  function send(method, params = {}) {
    const id = (messageId += 1);
    return new Promise((done, fail) => {
      pending.set(id, (message) =>
        message.error
          ? fail(new Error(`${method}: ${JSON.stringify(message.error)}`))
          : done(message.result)
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "page evaluation failed");
    }
    return result.result.value;
  }

  async function until(label, expression, timeoutMs) {
    const startedAt = Date.now();
    for (;;) {
      const value = await evaluate(expression);
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
      await sleep(200);
    }
  }

  return {
    send,
    evaluate,
    until,
    consoleErrors,
    requests,
    async navigate(url) {
      await send("Page.navigate", { url });
    },
    close() {
      socket.close();
    },
  };
}

/** Boot Chrome + a page + the local server, and hand all three to `run`. */
export async function withBrowserPage(dir, run) {
  const server = await serveDirectory(dir);
  const chrome = await launchChrome();
  const page = await openPage(chrome.ws);
  try {
    await page.send("Network.enable");
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return await run({ base: server.url, page });
  } finally {
    page.close();
    await chrome.close();
    await server.close();
  }
}
