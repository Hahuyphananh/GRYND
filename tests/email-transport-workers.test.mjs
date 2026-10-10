/**
 * Guards the email-transport split for Cloudflare Workers (Phase 5 of the
 * Vercel → Cloudflare migration).
 *
 * The app sends mail through `src/lib/resend.ts`, which is a Resend wrapper
 * with an OPTIONAL nodemailer/SMTP fallback. That fallback is fine on
 * Vercel/Node, but a Cloudflare Worker cannot open the raw TCP/TLS socket SMTP
 * needs, and nodemailer imports `node:net`/`node:tls` at module scope the
 * moment it is evaluated.
 *
 * So the contract this file pins down is:
 *
 *   1. On Workers the SMTP path is skipped before nodemailer is ever touched,
 *      making Resend the only transport there.
 *   2. nodemailer is NOT statically imported — only a type-only import plus a
 *      lazy `await import()` — so the Worker's module graph never has to load
 *      it (and the Vercel bundle still traces it for the Node SMTP path).
 *   3. Off-Workers behaviour is unchanged: `isCloudflareWorkers()` is false and
 *      the SMTP fallback is still reachable.
 *
 * If someone re-introduces a top-level `import nodemailer from "nodemailer"`,
 * the Worker starts crashing on every route that imports the email helpers —
 * this test fails instead.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const RESEND_PATH = "src/lib/resend.ts";
const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

const read = (p) => readFileSync(p, "utf8");
const src = read(RESEND_PATH);

test("nodemailer is never imported statically", () => {
  // Strip the type-only import, which is erased at compile time and is safe.
  const withoutTypeImports = src.replace(/import\s+type[^;]+;/g, "");
  assert.doesNotMatch(
    withoutTypeImports,
    /import\s+[^;]*\bfrom\s+["']nodemailer["']/,
    "resend.ts must not statically import nodemailer — a Worker cannot evaluate its node:net/node:tls imports",
  );
  assert.doesNotMatch(
    withoutTypeImports,
    /require\(\s*["']nodemailer["']\s*\)/,
    "resend.ts must not require nodemailer at module scope",
  );
  // The type-only import stays, so `tsc` still knows the transporter types.
  assert.match(
    src,
    /import\s+type\s+\{[^}]*\}\s+from\s+["']nodemailer["']/,
    "the nodemailer type-only import should remain for typing",
  );
});

test("nodemailer is loaded lazily, so it is only pulled in when SMTP is used", () => {
  assert.match(
    src,
    /await\s+import\(\s*["']nodemailer["']\s*\)/,
    "nodemailer should be loaded with a lazy dynamic import inside getSmtpTransport()",
  );
});

test("the SMTP path bails out on Cloudflare Workers before touching nodemailer", () => {
  const fn = src.slice(src.indexOf("async function getSmtpTransport"));
  const guardAt = fn.indexOf("isCloudflareWorkers()");
  const importAt = fn.indexOf('import("nodemailer")');
  assert.ok(guardAt !== -1, "getSmtpTransport() must consult isCloudflareWorkers()");
  assert.ok(importAt !== -1, "getSmtpTransport() must lazy-load nodemailer");
  assert.ok(
    guardAt < importAt,
    "the Worker guard must run BEFORE the nodemailer import, otherwise the module is evaluated on the edge",
  );
});

test("isCloudflareWorkers() is false off-Workers and true inside a Worker", async () => {
  const { isCloudflareWorkers } = await import("../src/lib/resend.ts");

  assert.equal(
    isCloudflareWorkers(),
    false,
    "with no Cloudflare context on globalThis (Vercel, Node, tests) the Worker branch must be off",
  );

  try {
    globalThis[CLOUDFLARE_CONTEXT_SYMBOL] = { env: {} };
    assert.equal(
      isCloudflareWorkers(),
      true,
      "the OpenNext Cloudflare context on globalThis must switch on the Worker branch",
    );
  } finally {
    delete globalThis[CLOUDFLARE_CONTEXT_SYMBOL];
  }

  assert.equal(
    isCloudflareWorkers(),
    false,
    "removing the context must switch the Worker branch back off",
  );
});
