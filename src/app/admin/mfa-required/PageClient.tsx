"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import InteractiveCasinoBg from "../../../components/InteractiveCasinoBg";

type Method = "email" | "totp" | "passphrase";
type Methods = Record<Method, boolean>;

const METHOD_LABELS: Record<Method, string> = {
  email: "Email code",
  totp: "Authenticator app",
  passphrase: "Passphrase",
};

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

  useEffect(() => {
    fetch("/api/admin/mfa/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && d.methods) {
          setMethods(d.methods);
          const first: Method = d.methods.email
            ? "email"
            : d.methods.totp
              ? "totp"
              : "passphrase";
          setActive(first);
        }
      })
      .catch(() => {});
  }, []);

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

        {/* Method tabs */}
        <div className="mb-5 flex flex-wrap gap-2">
          {(Object.keys(METHOD_LABELS) as Method[]).map((m) => (
            <button
              key={m}
              onClick={() => {
                setActive(m);
                setMessage(null);
              }}
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
        {active === "email" && (
          <div className="space-y-3">
            {!otpSent ? (
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
        {active === "totp" && (
          <div className="space-y-3">
            {!methods.totp ? (
              <p className="text-sm text-[#9dd8ff]/80">
                The authenticator app isn't configured. Set the{" "}
                <code className="text-[#f5ff3b]">ADMIN_TOTP_SECRET</code> env var
                to a base32 secret to enable this method.
              </p>
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
        {active === "passphrase" && (
          <div className="space-y-3">
            {!methods.passphrase ? (
              <p className="text-sm text-[#9dd8ff]/80">
                The passphrase isn't configured. Set the{" "}
                <code className="text-[#f5ff3b]">ADMIN_MFA_PASSPHRASE</code> env var
                to enable this method.
              </p>
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

        <div className="mt-6 flex items-center justify-between">
          <Link
            href="/"
            className="rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
          >
            Back to home
          </Link>
          <p className="text-xs text-[#9dd8ff]/70">
            Verification lasts 24 hours.
          </p>
        </div>
      </div>
    </div>
  );
}
