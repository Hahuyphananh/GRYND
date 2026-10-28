// tests/admin-mfa-gate-page.test.mjs
// The /admin/mfa-required gate must never present an unavailable factor as a
// dead end.
//
// After the move to a new VM, every factor can report as unconfigured and the
// page used to render its tabs DISABLED — the explanation of what to set lived
// inside a panel the admin could not open, so the only instruction visible was
// nothing at all. These are static contract checks on the page and the status
// endpoint it reads.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PAGE = fs.readFileSync("src/app/admin/mfa-required/PageClient.tsx", "utf8");
const STATUS = fs.readFileSync("src/app/api/admin/mfa/status/route.ts", "utf8");

test("gate page: an unavailable factor is still selectable", () => {
  // A disabled tab cannot show why it is off or what to set.
  assert.ok(
    !/disabled=\{!methods\[[a-z]+\]\}/.test(PAGE),
    "factor tabs must not be disabled when the factor is unconfigured",
  );
  assert.match(PAGE, /aria-pressed=\{active === [a-z]+\}/, "tabs must be real selectable buttons");
});

test("gate page: every factor has an explanation of what to configure", () => {
  assert.match(PAGE, /is not available on this server\./, "unavailable factors need a stated reason");

  for (const method of ["email", "totp", "passphrase"]) {
    assert.match(
      PAGE,
      new RegExp(`<FactorUnavailable\\s+method="${method}"`),
      `${method} panel must render the explanation when the factor is off`,
    );
  }

  // Names only: the page must never print a configured value.
  for (const name of ["ADMIN_TOTP_SECRET", "ADMIN_MFA_PASSPHRASE", "RESEND_API_KEY"]) {
    assert.ok(PAGE.includes(name), `the page must name ${name}`);
  }
  assert.ok(
    !/process\.env/.test(PAGE),
    "a client component must not read the server's environment",
  );
});

test("gate page: the TOTP dead end offers a usable secret to configure", () => {
  // The server has no secret to hand out, so the page generates the value the
  // operator pastes into the environment. It must be Web Crypto only.
  assert.match(PAGE, /crypto\.getRandomValues/, "the secret must be generated locally");
  assert.ok(!/from ["']crypto["']|require\(["']crypto["']\)/.test(PAGE), "no Node crypto in a client bundle");
  assert.match(PAGE, /ADMIN_TOTP_SECRET=\$\{generatedTotp\}/, "the copyable line must be the env assignment");
  assert.match(PAGE, /[A-Z2-7]{26}[A-Z2-7]/, "the secret alphabet must be RFC 4648 base32");
});

test("gate page: configuration can be re-checked and a failed check is reported", () => {
  assert.match(PAGE, /Re-check configuration/, "an operator needs a way to re-read the configuration");
  assert.match(PAGE, /loadStatus\(\)/, "the status read must be reusable");
  assert.match(
    PAGE,
    /Could not read the server/,
    "a failed status call must be surfaced, not silently defaulted",
  );
});

test("status endpoint: reports why each factor is unavailable, names only", () => {
  assert.match(STATUS, /reasons:\s*\{/, "status must return a per-factor reason map");
  for (const factor of ["email", "totp", "passphrase"]) {
    assert.match(
      STATUS,
      new RegExp(`reasons:[\\s\\S]{0,300}${factor}:\\s*diagnostics\\.factors\\.${factor}\\.reason`),
      `${factor} must report its diagnostics reason`,
    );
  }
  // The reason strings come from mfaDiagnostics, which is asserted elsewhere to
  // never return a configured value. The route must not add one here.
  assert.ok(!/reasons:[\s\S]{0,400}(process\.env|\.slice\(|\.length\b)/.test(STATUS));
});
