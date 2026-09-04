"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";

/**
 * User-level MFA gate page. Shown by the middleware when a signed-in user
 * with the email-OTP second factor enabled hasn't verified it recently.
 * Mirrors the admin MFA flow (same OTP mechanism, email-only).
 */
export default function MfaRequiredPage() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      // Signed-out visitors landing here go to sign-in and come back.
      window.location.href = "/sign-in?redirect_url=/";
      return;
    }
  }, [isLoaded, isSignedIn]);

  async function sendOtp() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/user/security/mfa/send", {
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

  async function verify() {
    if (code.trim().length === 0) {
      setMessage({ kind: "error", text: "Enter the code first." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/user/security/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setMessage({ kind: "success", text: "Verified. Redirecting…" });
        const redirect =
          new URLSearchParams(window.location.search).get("redirect_url") || "/";
        setTimeout(() => router.push(redirect), 600);
      } else {
        setMessage({ kind: "error", text: data.error || "Verification failed." });
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
          Verification Required
        </h1>
        <p className="mb-5 leading-relaxed text-[#c9f7ff]/90">
          Your account has two-factor authentication enabled. Verify a
          one-time code sent to your email to continue.
        </p>

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
            <div className="mt-3 flex gap-2">
              <button
                onClick={verify}
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

        {message && (
          <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${messageClass}`}>
            {message.text}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <a
            href="/"
            className="rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
          >
            Back to home
          </a>
          <p className="text-xs text-[#9dd8ff]/70">
            Verification lasts 24 hours.
          </p>
        </div>
      </div>
    </div>
  );
}