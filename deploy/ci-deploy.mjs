#!/usr/bin/env node
// deploy/ci-deploy.mjs
//
// Run on the production host by the approved GitHub Actions deploy job:
//
//   ssh deploy@host "cd /home/ubuntu/grynd/tool && GRYND_ALLOW_SERVICE_RESTART=1 \
//     node ci-deploy.mjs --root=/home/ubuntu/grynd" < request.json
//
// The request arrives on stdin as JSON; no value is interpolated into a shell
// command. The result on stdout is JSON and carries no secrets.
//
// Exit codes: 0 activated or already active, 1 deployment failed (including a
// reverted activation), 2 refused/invalid request.

import process from "node:process";

import { DeployError } from "./lib/layout.mjs";
import { ciDeployMain } from "./lib/ci-deploy.mjs";

try {
  const result = await ciDeployMain();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  const code = error instanceof DeployError ? error.code : "INTERNAL_ERROR";
  process.stdout.write(
    `${JSON.stringify({ ok: false, outcome: "refused", code, error: error.message }, null, 2)}\n`,
  );
  process.exitCode = 2;
}
