"use client";

import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import InteractiveCasinoBg from "../../components/InteractiveCasinoBg";

const isValidEmail = (email) => email.includes("@") && email.includes(".") && email.indexOf("@") > 0 && email.lastIndexOf(".") > email.indexOf("@") + 1;

export default function ContactPage() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState(null); // null | "sending" | "success" | "error"
  const [errorMsg, setErrorMsg] = useState("");
  const [errorSeverity, setErrorSeverity] = useState("error"); // "info" | "warning" | "error"

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !message.trim()) {
      setErrorSeverity("info");
      setErrorMsg("Email and message are required.");
      return;
    }
    if (!isValidEmail(email.trim())) {
      setErrorSeverity("info");
      setErrorMsg("Please enter a valid email address.");
      return;
    }
    setStatus("sending");
    setErrorMsg("");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          message: message.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus("success");
        setEmail("");
        setName("");
        setMessage("");
      } else {
        setStatus("error");
        // Determine severity from HTTP status: 4xx = info/warning, 5xx = error
        if (res.status === 429) setErrorSeverity("warning");
        else if (res.status >= 400 && res.status < 500) setErrorSeverity("info");
        else setErrorSeverity("error");
        setErrorMsg(data.error || "Something went wrong. Please try again.");
      }
    } catch {
      setStatus("error");
      setErrorSeverity("error");
      setErrorMsg("Network error. Please check your connection and try again.");
    }
  };

  // Auto-clear error when user starts typing
  const handleFieldChange = useCallback((setter, value) => {
    setter(value);
    if (errorMsg) {
      setErrorMsg("");
      setErrorSeverity("error");
    }
  }, [errorMsg]);

  return (
    <main className="relative min-h-screen bg-[#0a0f1e] text-white">
      <InteractiveCasinoBg variant="subtle" />

      {/* Back button */}
      <div className="max-w-4xl mx-auto px-4 pt-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/20 bg-white/5 text-sm text-gray-300 hover:bg-white/10 transition-colors"
        >
          ← Back to Home
        </Link>
      </div>

      {/* Hero header */}
      <div className="relative overflow-hidden border-b border-white/5">
        <div className="absolute inset-0 bg-gradient-to-b from-[#1a1f3e]/40 to-transparent pointer-events-none" />
        <div className="max-w-4xl mx-auto px-4 py-16 sm:py-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
              <span className="text-[#f5ff3b] drop-shadow-[0_0_12px_rgba(245,255,59,0.4)]">
                Contact
              </span>{" "}
              <span className="text-white">Us</span>
            </h1>
            <p className="mt-3 text-lg text-[#c9f7ff]/70 max-w-lg">
              Have a question, suggestion, or need support? Send us a message
              and we'll get back to you as soon as possible.
            </p>
          </motion.div>
        </div>
      </div>

      {/* Form section */}
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="grid lg:grid-cols-5 gap-10">
          {/* Contact info sidebar */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="lg:col-span-2 space-y-6"
          >
            <div className="bg-white/5 border border-white/10 rounded-xl p-6">
              <h3 className="text-sm font-semibold text-[#f5ff3b] uppercase tracking-wider mb-4">
                Reach Us
              </h3>
              <ul className="space-y-4 text-sm text-[#c9f7ff]/80">
                <li className="flex items-start gap-3">
                  <span className="text-[#f5ff3b] text-lg mt-0.5">✉</span>
                  <div>
                    <p className="font-medium text-white">Email</p>
                    <p className="text-[#c9f7ff]/60">contact@goonbet.dedyn.io</p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-[#f5ff3b] text-lg mt-0.5">⏱</span>
                  <div>
                    <p className="font-medium text-white">Response Time</p>
                    <p className="text-[#c9f7ff]/60">Within 24 hours</p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-[#f5ff3b] text-lg mt-0.5">🔒</span>
                  <div>
                    <p className="font-medium text-white">Secure</p>
                    <p className="text-[#c9f7ff]/60">
                      Your information is encrypted and never shared.
                    </p>
                  </div>
                </li>
              </ul>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-xl p-6">
              <h3 className="text-sm font-semibold text-[#f5ff3b] uppercase tracking-wider mb-4">
                Quick Links
              </h3>
              <ul className="space-y-2 text-sm">
                {[
                  { href: "/terms", label: "Terms of Service" },
                  { href: "/privacy-policy", label: "Privacy Policy" },
                  { href: "/fair-play", label: "Fair Play" },
                  { href: "/security-policy", label: "Security Policy" },
                ].map(({ href, label }) => (
                  <li key={href}>
                    <Link
                      href={href}
                      className="text-[#c9f7ff]/60 hover:text-[#f5ff3b] transition-colors duration-200"
                    >
                      → {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>

          {/* Form */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.25 }}
            className="lg:col-span-3"
          >
            <AnimatePresence mode="wait">
              {status === "success" ? (
                <motion.div
                  key="success"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="bg-white/5 border border-emerald-500/30 rounded-xl p-10 text-center"
                >
                  <div className="text-5xl mb-4">✅</div>
                  <h2 className="text-2xl font-bold text-white mb-2">
                    Message Sent!
                  </h2>
                  <p className="text-[#c9f7ff]/70 mb-6">
                    Thank you for reaching out. We'll get back to you within 24
                    hours.
                  </p>
                  <button
                    onClick={() => setStatus(null)}
                    className="px-6 py-2.5 bg-[#f5ff3b] text-[#0a0f1e] font-semibold rounded-lg hover:bg-[#f5ff3b]/90 transition-colors"
                  >
                    Send Another Message
                  </button>
                </motion.div>
              ) : (
                <motion.form
                  key="form"
                  onSubmit={handleSubmit}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="bg-white/5 border border-white/10 rounded-xl p-6 sm:p-8 space-y-5"
                >
                  {/* Name */}
                  <div>
                    <label
                      htmlFor="contact-name"
                      className="block text-sm font-medium text-[#c9f7ff]/80 mb-1.5"
                    >
                      Your Name{" "}
                      <span className="text-[#c9f7ff]/40">(optional)</span>
                    </label>
                    <input
                      id="contact-name"
                      type="text"
                      value={name}
                      onChange={(e) => handleFieldChange(setName, e.target.value)}
                      placeholder="John Doe"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-[#c9f7ff]/30 outline-none transition-all focus:border-[#f5ff3b]/50 focus:bg-white/[0.07] focus:ring-1 focus:ring-[#f5ff3b]/20"
                    />
                  </div>

                  {/* Email */}
                  <div>
                    <label
                      htmlFor="contact-email"
                      className="block text-sm font-medium text-[#c9f7ff]/80 mb-1.5"
                    >
                      Your Email <span className="text-red-400">*</span>
                    </label>
                    <input
                      id="contact-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => handleFieldChange(setEmail, e.target.value)}
                      placeholder="you@example.com"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-[#c9f7ff]/30 outline-none transition-all focus:border-[#f5ff3b]/50 focus:bg-white/[0.07] focus:ring-1 focus:ring-[#f5ff3b]/20"
                    />
                  </div>

                  {/* Message */}
                  <div>
                    <label
                      htmlFor="contact-message"
                      className="block text-sm font-medium text-[#c9f7ff]/80 mb-1.5"
                    >
                      Message <span className="text-red-400">*</span>
                    </label>
                    <textarea
                      id="contact-message"
                      required
                      rows={5}
                      value={message}
                      onChange={(e) => handleFieldChange(setMessage, e.target.value)}
                      placeholder="Tell us how we can help..."
                      maxLength={5000}
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-[#c9f7ff]/30 outline-none transition-all focus:border-[#f5ff3b]/50 focus:bg-white/[0.07] focus:ring-1 focus:ring-[#f5ff3b]/20 resize-y min-h-[120px]"
                    />
                    <p className="text-xs text-[#c9f7ff]/40 mt-1 text-right">
                      {message.length}/5000
                    </p>
                  </div>

                  {/* Error */}
                  {errorMsg && (
                    <div
                      className={`p-3 border rounded-lg text-sm ${
                        errorSeverity === "info"
                          ? "bg-blue-500/10 border-blue-500/30 text-blue-300"
                          : errorSeverity === "warning"
                          ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-300"
                          : "bg-red-500/10 border-red-500/30 text-red-300"
                      }`}
                    >
                      <span className="inline-block mr-2">
                        {errorSeverity === "info" ? "ℹ️" : errorSeverity === "warning" ? "⚠️" : "❌"}
                      </span>
                      {errorMsg}
                    </div>
                  )}

                  {/* Submit */}
                  <button
                    type="submit"
                    disabled={status === "sending"}
                    className="w-full py-3 bg-[#f5ff3b] text-[#0a0f1e] font-bold rounded-lg hover:bg-[#f5ff3b]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 hover:shadow-[0_0_24px_rgba(245,255,59,0.3)] active:scale-[0.98]"
                  >
                    {status === "sending" ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-[#0a0f1e] border-t-transparent" />
                        Sending...
                      </span>
                    ) : (
                      "Send Message"
                    )}
                  </button>
                </motion.form>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </main>
  );
}
