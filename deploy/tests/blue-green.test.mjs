// The switch itself: which slot is started, what nginx is told, and what is
// stopped. The point of these tests is ordering — nginx must never name a slot
// that has not answered /api/health, and a failed standby must leave the live
// slot untouched.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSystemdController } from "../lib/services.mjs";

async function fixture({ active = "a", withPrevious = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-bg-"));
  for (const id of ["rel-old", "rel-new"]) {
    await fs.mkdir(path.join(root, "releases", id, "app"), { recursive: true });
  }
  await fs.mkdir(path.join(root, "slots"));
  await fs.mkdir(path.join(root, "state"));
  const target = (id) => path.join(root, "releases", id);
  await fs.symlink(target("rel-old"), path.join(root, "slots", "a"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(target(withPrevious ? "rel-old" : "rel-new"), path.join(root, "slots", "b"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(root, "state", "app-slot"), `${active}\n`);
  return { root, target };
}

function recordingExec(log, { failOn = null } = {}) {
  return (file, args, options, callback) => {
    const line = [file, ...args].join(" ");
    log.push(line);
    if (failOn && line.includes(failOn)) {
      callback(new Error("boom"), "", "boom");
      return;
    }
    callback(null, "", "");
  };
}

async function upstreamPort(root) {
  const text = await fs.readFile(path.join(root, "state", "upstream-server.conf"), "utf8");
  return text.trim();
}

test("blue/green: idle slot starts, is health-checked, then nginx switches and the old slot stops", async () => {
  const { root } = await fixture();
  const log = [];
  const controller = createSystemdController({
    root,
    allow: true,
    exec: recordingExec(log),
    upstreamFile: path.join(root, "state", "upstream-server.conf"),
    health: async (port) => {
      log.push(`health ${port}`);
      return { ok: true };
    },
  });

  await controller.restart({ releaseId: "rel-new", restartRealtime: false });

  const slotB = await fs.readlink(path.join(root, "slots", "b"));
  assert.equal(slotB, path.join(root, "releases", "rel-new"));
  assert.equal(await fs.readFile(path.join(root, "state", "app-slot"), "utf8"), "b\n");
  // The activation health gate must probe the port the switch just moved to.
  assert.equal(await controller.servingPort(), 3002);

  assert.equal(log.filter((line) => line.includes("systemctl start grynd-app-b.service")).length, 1);
  assert.equal(log.filter((line) => line.includes("systemctl stop grynd-app-a.service")).length, 1);
  assert.equal(log.filter((line) => line.includes("reload nginx")).length, 1);

  const startAt = log.findIndex((line) => line.includes("start grynd-app-b.service"));
  const healthAt = log.findIndex((line) => line.startsWith("health 3002"));
  const reloadAt = log.findIndex((line) => line.includes("reload nginx"));
  const stopAt = log.findIndex((line) => line.includes("stop grynd-app-a.service"));
  assert.ok(startAt < healthAt && healthAt < reloadAt && reloadAt < stopAt, log.join("\n"));
  assert.equal(await upstreamPort(root), "server 127.0.0.1:3002;");
});

test("blue/green: a standby that never becomes healthy is stopped and nginx is not touched", async () => {
  const { root } = await fixture();
  const log = [];
  const controller = createSystemdController({
    root,
    allow: true,
    exec: recordingExec(log),
    upstreamFile: path.join(root, "state", "upstream-server.conf"),
    health: async () => {
      throw new Error("no answer");
    },
  });

  await assert.rejects(
    () => controller.restart({ releaseId: "rel-new", restartRealtime: false }),
    (error) => error.code === "SLOT_ACTIVATION_FAILED",
  );

  await assert.rejects(() => fs.readFile(path.join(root, "state", "upstream-server.conf"), "utf8"));
  assert.equal(log.filter((line) => line.includes("reload nginx")).length, 0);
  assert.equal(log.filter((line) => line.includes("stop grynd-app-b.service")).length, 1);
  assert.equal(log.filter((line) => line.includes("stop grynd-app-a.service")).length, 0);
  // The live slot and the recorded slot are unchanged.
  assert.equal(await fs.readFile(path.join(root, "state", "app-slot"), "utf8"), "a\n");
  assert.equal(await fs.readlink(path.join(root, "slots", "b")), path.join(root, "releases", "rel-old"));
});

test("blue/green: alternate activations flip a→b→a without reusing a port", async () => {
  const { root } = await fixture();
  const log = [];
  const controller = createSystemdController({
    root,
    allow: true,
    exec: recordingExec(log),
    upstreamFile: path.join(root, "state", "upstream-server.conf"),
    health: async () => ({ ok: true }),
  });

  await controller.restart({ releaseId: "rel-new", restartRealtime: false });
  await controller.restart({ releaseId: "rel-old", restartRealtime: false });

  assert.equal(await fs.readFile(path.join(root, "state", "app-slot"), "utf8"), "a\n");
  assert.equal(log.filter((line) => line.includes("start grynd-app-a.service")).length, 1);
  assert.equal(log.filter((line) => line.includes("start grynd-app-b.service")).length, 1);
  // The last switch is back on blue's port.
  assert.equal(await upstreamPort(root), "server 127.0.0.1:3000;");
});

test("blue/green: without slots the controller keeps the plain restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grynd-legacy-"));
  const log = [];
  const controller = createSystemdController({ root, allow: true, exec: recordingExec(log) });

  await controller.restart({ releaseId: "rel-new", restartRealtime: false });

  assert.ok(log.some((line) => line.includes("systemctl restart grynd-app.service")));
  assert.equal(log.filter((line) => line.includes("nginx")).length, 0);
});
