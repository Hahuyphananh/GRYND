#!/usr/bin/env node
// deploy/record-deployment.mjs
//
// Append one workflow deployment record on the host. The record arrives on
// stdin; unknown fields are discarded by the schema in lib/workflow-records.mjs.
//
//   ssh deploy@host "cd /home/ubuntu/grynd/tool && node record-deployment.mjs \
//     --root=/home/ubuntu/grynd" < record.json

import process from "node:process";

import { DeployError, layout, releaseRoot } from "./lib/layout.mjs";
import {
  MAX_RECORD_BYTES,
  appendDeploymentRecord,
  sanitizeDeploymentRecord,
} from "./lib/workflow-records.mjs";

function readRoot(argv) {
  const flag = argv.find((arg) => arg.startsWith("--root="));
  const root = flag ? flag.slice("--root=".length) : releaseRoot();
  if (!root.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(root)) {
    throw new DeployError("--root must be an absolute path", "INVALID_ROOT");
  }
  return root;
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_RECORD_BYTES) {
      throw new DeployError("deployment record is too large", "INVALID_RECORD");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const root = readRoot(process.argv.slice(2));
  let parsed;
  try {
    parsed = JSON.parse(await readStdin());
  } catch {
    throw new DeployError("deployment record is not valid JSON", "INVALID_RECORD");
  }

  const record = sanitizeDeploymentRecord(parsed);
  const result = await appendDeploymentRecord(layout(root), record);
  process.stdout.write(
    `${JSON.stringify({ ok: true, runId: record.runId, commit: record.commit, total: result.total }, null, 2)}\n`,
  );
} catch (error) {
  const code = error instanceof DeployError ? error.code : "INTERNAL_ERROR";
  process.stdout.write(`${JSON.stringify({ ok: false, code, error: error.message }, null, 2)}\n`);
  process.exitCode = 2;
}
