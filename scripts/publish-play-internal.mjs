#!/usr/bin/env node
/**
 * scripts/publish-play-internal.mjs
 *
 * Upload a signed AAB to a Google Play track (internal testing by default).
 *
 * WHY THIS EXISTS INSTEAD OF AN ACTION OR FASTLANE
 * The thing this script handles is a service-account key with permission to
 * publish. Putting that key through a third-party GitHub Action means trusting
 * that action's supply chain with production release rights, and fastlane pulls
 * a large Ruby dependency tree into a Node repository. The Google Play
 * Developer API is a plain OAuth2 + REST flow, so this is ~150 lines of
 * `node:crypto` and `fetch` — no dependency, reviewable in one sitting, and the
 * credential never leaves this process.
 *
 * THE FLOW (androidpublisher v3 "edits", which is transactional)
 *   1. sign a JWT with the service-account key → exchange it for an access
 *      token (scope: androidpublisher)
 *   2. POST  /applications/{pkg}/edits                     → an edit id
 *   3. POST  /edits/{id}/bundles?uploadType=media           → uploads the AAB,
 *                                                             returns its versionCode
 *   4. PUT   /edits/{id}/tracks/{track}                     → attaches that
 *                                                             versionCode to the
 *                                                             track
 *   5. POST  /edits/{id}:commit                             → makes it live
 * An edit that is never committed changes nothing, so a failure before step 5
 * leaves Play untouched; the script also deletes the edit on the way out.
 *
 * WHAT IT DOES NOT DO
 *   * It does not promote to production. The default track is `internal`.
 *   * It does not bump versionCode. Play rejects a reused code, so the build
 *     that produced the AAB must already carry a new one
 *     (scripts/check-android-version.mjs enforces that in review).
 *
 * CREDENTIALS
 *   PLAY_SERVICE_ACCOUNT_JSON   the service-account JSON, as a string
 *   or --service-account <path>
 * The account needs "Release to testing tracks" (Play Console → Users and
 * permissions) and must be linked to the app. Its JSON is git-ignored by the
 * `serviceAccount*.json` rule; never commit it.
 *
 * USAGE
 *   node scripts/publish-play-internal.mjs --aab dist/app.aab \
 *     --package com.grynd.app --track internal --notes "What's new"
 *   node scripts/publish-play-internal.mjs ... --dry-run    # validate, no network
 */

import { createSign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const NOTE_LIMIT = 500;
const TIMEOUT_MS = 120_000;

export class PlayApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "PlayApiError";
    this.status = status;
    this.body = body;
  }
}

/** base64url without padding — the encoding JWT requires. */
export function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function buildAssertionClaims({ clientEmail, now, lifetimeSeconds = 3600 }) {
  if (!clientEmail) throw new Error("service account JSON has no client_email");
  const issuedAt = typeof now === "number" ? now : Math.floor(Date.now() / 1000);
  return {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
  };
}

/** A signed RS256 JWT assertion for the OAuth2 token exchange. */
export function signAssertion({ clientEmail, privateKey, now }) {
  if (!privateKey) throw new Error("service account JSON has no private_key");
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify(buildAssertionClaims({ clientEmail, now })));
  const signature = base64url(
    createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey)
  );
  return `${header}.${claims}.${signature}`;
}

/**
 * The edit's track body.
 *
 * `status: "completed"` means the release is fully rolled out to THIS track —
 * for internal testing that is exactly right. `versionCodes` are strings in the
 * API; sending numbers is accepted by the JSON parser but shows up as a diff in
 * every tool that reads it back.
 */
export function buildTrackBody({ track, versionCodes, notes, language = "en-US" }) {
  if (!track) throw new Error("a track is required");
  if (!Array.isArray(versionCodes) || versionCodes.length === 0) {
    throw new Error("at least one versionCode is required");
  }
  if (!versionCodes.every((code) => /^\d+$/.test(String(code)))) {
    throw new Error(`versionCode must be numeric, got ${JSON.stringify(versionCodes)}`);
  }

  const release = {
    status: "completed",
    versionCodes: versionCodes.map((code) => String(code)),
  };

  const text = (notes ?? "").trim();
  if (text) {
    // Play rejects a longer note; truncate rather than fail a publish at the
    // last step for a cosmetic reason.
    release.releaseNotes = [{ language, text: text.slice(0, NOTE_LIMIT) }];
  }

  return { track, releases: [release] };
}

async function readJson(response) {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

async function tokenFor(serviceAccount) {
  const assertion = signAssertion({
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await readJson(response);
  if (!response.ok || !body.access_token) {
    throw new PlayApiError(
      `token exchange failed (HTTP ${response.status}): ${body.error_description || body.error || "no access_token"}`,
      response.status,
      body
    );
  }
  return body.access_token;
}

function loadServiceAccount(argv) {
  const index = argv.indexOf("--service-account");
  const path = index >= 0 ? argv[index + 1] : null;

  if (path) {
    if (!existsSync(path)) throw new Error(`service account file not found: ${path}`);
    return JSON.parse(readFileSync(path, "utf8"));
  }

  const inline = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!inline || !inline.trim()) {
    throw new Error(
      "no service account: set PLAY_SERVICE_ACCOUNT_JSON or pass --service-account <path>"
    );
  }
  return JSON.parse(inline);
}

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

async function main(argv) {
  const aabPath = arg(argv, "--aab");
  const pkg = arg(argv, "--package") || "com.grynd.app";
  const track = arg(argv, "--track") || "internal";
  const notes = arg(argv, "--notes") || "";
  const language = arg(argv, "--language") || "en-US";
  const dryRun = argv.includes("--dry-run");

  if (!aabPath) throw new Error("--aab <path> is required");
  if (!existsSync(aabPath)) throw new Error(`AAB not found: ${aabPath}`);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) {
    throw new Error(`not a valid application id: ${pkg}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(track)) {
    throw new Error(`not a valid track name: ${track}`);
  }

  const size = statSync(aabPath).size;
  if (size <= 0) throw new Error(`AAB is empty: ${aabPath}`);

  const serviceAccount = loadServiceAccount(argv);

  if (dryRun) {
    // Validate the key and the body without touching Play.
    const assertion = signAssertion({
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key,
    });
    const body = buildTrackBody({ track, versionCodes: ["0"], notes, language });
    console.log("dry run — no request was sent");
    console.log(`  aab        ${aabPath} (${size} bytes)`);
    console.log(`  package    ${pkg}`);
    console.log(`  account    ${serviceAccount.client_email}`);
    console.log(`  assertion  ${assertion.split(".").length} JWT segments`);
    console.log(`  track body ${JSON.stringify(body)}`);
    return;
  }

  const token = await tokenFor(serviceAccount);
  const auth = { authorization: `Bearer ${token}` };

  let editId = null;
  try {
    const editResponse = await fetch(`${API}/applications/${pkg}/edits`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const edit = await readJson(editResponse);
    if (!editResponse.ok || !edit.id) {
      throw new PlayApiError(
        `could not open an edit (HTTP ${editResponse.status}) — does the account have "Release to testing tracks" on ${pkg}?`,
        editResponse.status,
        edit
      );
    }
    editId = edit.id;

    const uploadResponse = await fetch(
      `${API}/applications/${pkg}/edits/${editId}/bundles?uploadType=media`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/octet-stream" },
        body: new Uint8Array(readFileSync(aabPath)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    const uploaded = await readJson(uploadResponse);
    if (!uploadResponse.ok || !uploaded.versionCode) {
      throw new PlayApiError(
        `bundle upload failed (HTTP ${uploadResponse.status}) — a reused versionCode is the usual cause`,
        uploadResponse.status,
        uploaded
      );
    }
    const versionCode = String(uploaded.versionCode);

    const trackBody = buildTrackBody({ track, versionCodes: [versionCode], notes, language });
    const trackResponse = await fetch(
      `${API}/applications/${pkg}/edits/${editId}/tracks/${track}`,
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(trackBody),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    if (!trackResponse.ok) {
      throw new PlayApiError(
        `track update failed (HTTP ${trackResponse.status})`,
        trackResponse.status,
        await readJson(trackResponse)
      );
    }

    const commitResponse = await fetch(`${API}/applications/${pkg}/edits/${editId}:commit`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!commitResponse.ok) {
      throw new PlayApiError(
        `commit failed (HTTP ${commitResponse.status})`,
        commitResponse.status,
        await readJson(commitResponse)
      );
    }

    console.log(`✔ uploaded versionCode ${versionCode} to the "${track}" track of ${pkg}`);
    console.log(`  edit ${editId} committed — the release is live on ${track} testing`);
  } catch (error) {
    // An uncommitted edit expires by itself, but leaving it open blocks the
    // next edit on some accounts. Best effort: never mask the original error.
    if (editId) {
      try {
        await fetch(`${API}/applications/${pkg}/edits/${editId}`, {
          method: "DELETE",
          headers: auth,
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    if (error instanceof PlayApiError && error.body && error.body.raw) {
      console.error(String(error.body.raw).slice(0, 500));
    }
    process.exit(1);
  });
}
