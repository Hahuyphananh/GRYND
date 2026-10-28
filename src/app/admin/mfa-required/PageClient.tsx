"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import InteractiveCasinoBg from "../../../components/InteractiveCasinoBg";

type Method = "email" | "totp" | "passphrase";
type Methods = Record<Method, boolean>;
type Reasons = Record<Method, string | null>;

const METHOD_LABELS: Record<Method, string> = {
  email: "Email code",
  totp: "Authenticator app",
  passphrase: "Passphrase",
};

// What an unconfigured factor needs. NAMES ONLY — /api/admin/mfa/status never
// returns a value, and neither does this page.
const METHOD_HELP: Record<Method, { variables: string[]; detail: string }> = {
  email: {
    variables: ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS"],
    detail:
      "Email codes need a mail provider. Set RESEND_API_KEY (with RESEND_FROM_EMAIL), or SMTP_HOST together with SMTP_USER and SMTP_PASS.",
  },
  totp: {
    variables: ["ADMIN_TOTP_SECRET"],
    detail:
      "The authenticator app needs a base32 secret shared by every admin. Set ADMIN_TOTP_SECRET to one.",
  },
  passphrase: {
    variables: ["ADMIN_MFA_PASSPHRASE"],
    detail:
      "The passphrase factor compares what you type against a server value. Set ADMIN_MFA_PASSPHRASE to one.",
  },
};

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Same encoding as `generateBase32Secret` in src/lib/auth/totp.ts. It is
 * duplicated here because that module imports Node's `crypto` and cannot be
 * pulled into a client bundle; this half only uses Web Crypto (`randomValues`),
 * which is available in the browser.
 */
function generateBase32Secret(bytes = 20): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * The explanation shown in place of a form that cannot possibly succeed.
 * Hoisted out of the page component so its identity is stable across renders.
 */
function FactorUnavailable({
  method,
  reason,
  generatedTotp,
  onGenerate,
  copied,
  onCopy,
}: {
  method: Method;
  reason: string | null;
  generatedTotp?: string | null;
  onGenerate?: () => void;
  copied?: boolean;
  onCopy?: (value: string) => void;
}) {
  const help = METHOD_HELP[method];
  return (
    <div className="space-y-3 rounded-lg border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-100">
      <p className="font-semibold">
        {METHOD_LABELS[method]} is not available on this server.
      </p>
      <p className="text-amber-100/80">{reason ?? help.detail}</p>
      <p className="flex flex-wrap items-center gap-2 text-xs text-amber-100/80">
        <span>Configured through</span>
        {help.variables.map((name) => (
          <code key={name} className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[#f5ff3b]">
            {name}
          </code>
        ))}
        <span>then restart the app.</span>
      </p>

      {method === "totp" && (
        <div className="space-y-2 rounded-lg border border-[#00e5ff]/20 bg-black/30 p-3 text-xs text-[#c9f7ff]/90">
          <p>
            There is no secret to copy from here — the server has none. Generate one, add it to
            the server environment, and restart:
          </p>
          {generatedTotp ? (
            <>
              <code className="block break-all rounded bg-black/40 px-2 py-1 text-[#f5ff3b]">
                ADMIN_TOTP_SECRET={generatedTotp}
              </code>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => onCopy?.(`ADMIN_TOTP_SECRET=${generatedTotp}`)}
                  className="rounded-lg border border-[#00e5ff]/40 px-3 py-1.5 font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={onGenerate}
                  className="rounded-lg border border-[#00e5ff]/40 px-3 py-1.5 font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
                >
                  Regenerate
                </button>
              </div>
              <p className="text-[#9dd8ff]/80">
                Once the app has restarted, re-check below: this tab becomes active and accepts a
                code from your authenticator app. Add the secret to the app from the server
                environment — “Show setup details” only answers a session that is already verified.
              </p>
            </>
          ) : (
            <button
              onClick={onGenerate}
              className="rounded-lg border border-[#00e5ff]/40 px-3 py-1.5 font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
            >
              Generate a base32 secret
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminMfaRequiredPage() {
  const [methods, setMethods] = useState<Methods>({
    email: true,
    totp: false,
    passphrase: false,
  });
  const [active, setActive] = useState<Method>("email");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "info" | "error" | "success";
    text: string;
  } | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{
    secret: string;
    otpauthUrl: string;
    qrDataUrl: string | null;
  } | null>(null);
  // Reported by /status: which dependencies are missing on THIS host. Presence
  // only — the endpoint never returns a value.
  const [diagnostics, setDiagnostics] = useState<{
    warnings: Array<{ code: string; severity: string; message: string }>;
    otpStore: string | null;
    requiredVariables: string[];
    reasons: Reasons;
  } | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [generatedTotp, setGeneratedTotp] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /**
   * Ask the server which factors it can actually honour. Called again by the
   * "Re-check" button so an operator who has just set an env var can confirm it
   * without guessing (a restart is still required for the value to load).
   */
  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const res = await fetch("/api/admin/mfa/status", { credentials: "include" });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success || !d.methods) {
        // Silence here used to leave the page looking like a working form that
        // every submission rejected. Say what happened instead.
        setStatusError(
          d?.error ||
            (res.status === 401 || res.status === 403
              ? "The server did not accept this session as an admin session, so it could not report which factors are configured."
              : "The server could not report which factors are configured."),
        );
        return;
      }
      setMethods(d.methods);
      setDiagnostics({
        warnings: Array.isArray(d.warnings) ? d.warnings : [],
        otpStore: typeof d.otpStore === "string" ? d.otpStore : null,
        requiredVariables: Array.isArray(d.requiredVariables) ? d.requiredVariables : [],
        reasons: {
          email: typeof d.reasons?.email === "string" ? d.reasons.email : null,
          totp: typeof d.reasons?.totp === "string" ? d.reasons.totp : null,
          passphrase: typeof d.reasons?.passphrase === "string" ? d.reasons.passphrase : null,
        },
      });
      const first: Method = d.methods.email ? "email" : d.methods.totp ? "totp" : "passphrase";
      setActive(first);
      if (!d.methods.totp) setTotpSetup(null);
    } catch {
      setStatusError("Could not reach the server to check which factors are configured.");
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const anyAvailable = methods.email || methods.totp || methods.passphrase;

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((k) => (k === key ? null : k)), 2000);
    } catch {
      setMessage({ kind: "error", text: "Could not copy to the clipboard." });
    }
  }

  async function sendOtp() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/mfa/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setOtpSent(true);
        setMessage({
          kind: "success",
          text: "Code sent to your email. It expires in 5 minutes.",
        });
      } else {
        setMessage({ kind: "error", text: data.error || "Failed to send the code." });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function verify(method: Method) {
    if (code.trim().length === 0) {
      setMessage({ kind: "error", text: "Enter the code first." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ method, code }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setMessage({ kind: "success", text: "Verified. Redirecting…" });
        window.location.href = "/admin";
      } else {
        setMessage({ kind: "error", text: data.error || "Verification failed." });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function loadTotpSetup() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/mfa/setup-totp", { credentials: "include" });
      const data = await res.json();
      if (res.ok && data.success) {
        setTotpSetup({
          secret: data.secret,
          otpauthUrl: data.otpauthUrl,
          qrDataUrl: data.qrDataUrl ?? null,
        });
      } else {
        setMessage({
          kind: "error",
          text: data.error || "Authenticator app isn't configured.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  const messageClass =
    message?.kind === "error"
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : message?.kind === "success"
        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
        : "border-[#00e5ff]/30 bg-[#00e5ff]/10 text-[#d8fbff]";

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-16">
      <InteractiveCasinoBg variant="subtle" />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-[#f5ff3b]/30 bg-[#040d24]/90 p-8 shadow-[0_0_40px_rgba(245,255,59,0.15)] backdrop-blur-md">
        <h1 className="mb-3 text-2xl font-extrabold text-[#f5ff3b]">
          Multi-Factor Authentication Required
        </h1>
        <p className="mb-4 leading-relaxed text-[#c9f7ff]/90">
          The admin dashboard is locked until you verify a second factor. Choose
          any method below.
        </p>

        {!statusLoaded && (
          <p className="mb-5 text-sm text-[#9dd8ff]/80">
            Checking which second factors this server can honour…
          </p>
        )}

        {/* The status call failed: without it the page cannot tell which factors
            work, so say so rather than presenting a form that will reject. */}
        {statusLoaded && statusError && (
          <div className="mb-5 rounded-lg border border-red-400/50 bg-red-500/10 p-4 text-sm text-red-200">
            <p className="font-semibold">Could not read the server&apos;s MFA configuration.</p>
            <p className="mt-1 text-red-200/80">{statusError}</p>
            <button
              onClick={() => {
                setStatusLoaded(false);
                void loadStatus();
              }}
              className="mt-3 rounded-lg border border-red-300/40 px-3 py-1.5 text-xs font-semibold text-red-100 transition-all hover:bg-red-400/10"
            >
              Try again
            </button>
          </div>
        )}

        {/* No factor configured: say so, instead of offering a form that cannot work. */}
        {statusLoaded && !anyAvailable && (
          <div className="mb-5 rounded-lg border border-red-400/50 bg-red-500/10 p-4 text-sm text-red-200">
            <p className="font-semibold">No admin second factor is configured on this server.</p>
            <p className="mt-1 text-red-200/80">
              Verification is refused until at least one factor is configured. An administrator must set one of
              these environment variables on the server and restart the app:
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 font-mono text-xs text-red-100/80">
              <li>ADMIN_MFA_PASSPHRASE — passphrase</li>
              <li>ADMIN_TOTP_SECRET — authenticator app</li>
              <li>RESEND_API_KEY, or SMTP_HOST + SMTP_USER + SMTP_PASS — email codes</li>
            </ul>
            {diagnostics?.otpStore === "memory" && (
              <p className="mt-2 text-xs text-amber-200/80">
                Email codes are currently held in process memory (no Redis configured), so a restart between
                sending and verifying invalidates the code.
              </p>
            )}
          </div>
        )}

        {/* Method tabs. An unavailable factor stays selectable on purpose: its
            panel explains why it is off and what to set, which a disabled tab
            could never show. */}
        <div className="mb-5 flex flex-wrap gap-2">
          {(Object.keys(METHOD_LABELS) as Method[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                setActive(m);
                setMessage(null);
              }}
              aria-pressed={active === m}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b] ${
                active === m
                  ? "bg-[#f5ff3b] text-[#1f1700]"
                  : "border border-[#00e5ff]/30 bg-[#08142f] text-[#d8fbff] hover:bg-[#10234a]"
              }`}
            >
              {METHOD_LABELS[m]}
              {!methods[m] && (
                <span className="ml-1 text-[10px] opacity-60">(off)</span>
              )}
            </button>
          ))}
        </div>

        {/* Email method */}
        {statusLoaded && active === "email" && (
          <div className="space-y-3">
            {!methods.email ? (
              <FactorUnavailable method="email" reason={diagnostics?.reasons.email ?? null} />
            ) : !otpSent ? (
              <button
                onClick={sendOtp}
                disabled={busy}
                className="w-full rounded-lg border border-[#f5ff3b]/50 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.4)] transition-all hover:shadow-[0_0_26px_rgba(245,255,59,0.65)] disabled:opacity-60"
              >
                {busy ? "Sending…" : "Send code to my email"}
              </button>
            ) : (
              <>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#08142f] px-4 py-2.5 text-center text-lg tracking-[0.5em] text-[#ecf8ff] focus:outline-none focus:ring-2 focus:ring-[#00e5ff]"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => verify("email")}
                    disabled={busy}
                    className="flex-1 rounded-lg border border-[#f5ff3b]/50 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.4)] transition-all hover:shadow-[0_0_26px_rgba(245,255,59,0.65)] disabled:opacity-60"
                  >
                    {busy ? "Verifying…" : "Verify"}
                  </button>
                  <button
                    onClick={sendOtp}
                    disabled={busy}
                    className="rounded-lg border border-[#00e5ff]/40 px-4 py-2.5 text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10 disabled:opacity-60"
                  >
                    Resend
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Authenticator app method */}
        {statusLoaded && active === "totp" && (
          <div className="space-y-3">
            {!methods.totp ? (
              <FactorUnavailable
                method="totp"
                reason={diagnostics?.reasons.totp ?? null}
                generatedTotp={generatedTotp}
                onGenerate={() => setGeneratedTotp(generateBase32Secret())}
                copied={copied === "totp-secret"}
                onCopy={(value) => void copyText(value, "totp-secret")}
              />
            ) : (
              <>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#08142f] px-4 py-2.5 text-center text-lg tracking-[0.5em] text-[#ecf8ff] focus:outline-none focus:ring-2 focus:ring-[#00e5ff]"
                />
                <button
                  onClick={() => verify("totp")}
                  disabled={busy}
                  className="w-full rounded-lg border border-[#f5ff3b]/50 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.4)] transition-all hover:shadow-[0_0_26px_rgba(245,255,59,0.65)] disabled:opacity-60"
                >
                  {busy ? "Verifying…" : "Verify"}
                </button>
                <button
                  onClick={loadTotpSetup}
                  disabled={busy}
                  className="w-full rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10 disabled:opacity-60"
                >
                  Show setup details
                </button>
                {totpSetup && (
                  <div className="rounded-lg border border-[#00e5ff]/20 bg-black/30 p-3 text-xs text-[#c9f7ff]/90">
                    {totpSetup.qrDataUrl && (
                      <img
                        src={totpSetup.qrDataUrl}
                        alt="Scan to add GRYND to your authenticator app"
                        className="mx-auto mb-3 h-44 w-44 rounded-lg bg-white p-1"
                      />
                    )}
                    <p className="mb-1">
                      Scan the QR code, or add this secret manually:
                    </p>
                    <code className="block break-all rounded bg-black/40 px-2 py-1 text-[#f5ff3b]">
                      {totpSetup.secret}
                    </code>
                    <p className="mt-2 mb-1">Or use this URI:</p>
                    <code className="block break-all rounded bg-black/40 px-2 py-1 text-[#9dd8ff]">
                      {totpSetup.otpauthUrl}
                    </code>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Passphrase method */}
        {statusLoaded && active === "passphrase" && (
          <div className="space-y-3">
            {!methods.passphrase ? (
              <FactorUnavailable
                method="passphrase"
                reason={diagnostics?.reasons.passphrase ?? null}
              />
            ) : (
              <>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="Admin passphrase"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full rounded-lg border border-[#00e5ff]/40 bg-[#08142f] px-4 py-2.5 text-[#ecf8ff] focus:outline-none focus:ring-2 focus:ring-[#00e5ff]"
                />
                <button
                  onClick={() => verify("passphrase")}
                  disabled={busy}
                  className="w-full rounded-lg border border-[#f5ff3b]/50 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.4)] transition-all hover:shadow-[0_0_26px_rgba(245,255,59,0.65)] disabled:opacity-60"
                >
                  {busy ? "Verifying…" : "Verify"}
                </button>
              </>
            )}
          </div>
        )}

        {message && (
          <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${messageClass}`}>
            {message.text}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/"
              className="rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
            >
              Back to home
            </Link>
            {statusLoaded && (
              <button
                onClick={() => {
                  setStatusLoaded(false);
                  setMessage(null);
                  void loadStatus();
                }}
                className="rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
              >
                Re-check configuration
              </button>
            )}
          </div>
          <p className="text-xs text-[#9dd8ff]/70">
            Verification lasts 24 hours.
          </p>
        </div>
      </div>
    </div>
  );
}
