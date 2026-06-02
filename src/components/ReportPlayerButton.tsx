"use client";

import { FormEvent, useMemo, useState } from "react";

type ReportReason = "toxic_player" | "hacker" | "inappropriate_name" | "inappropriate_profile_picture" | "other";

const REPORT_REASONS: { value: ReportReason; label: string; helper: string }[] = [
  { value: "toxic_player", label: "Toxic player", helper: "Harassment, hate, threats, or abusive behavior." },
  { value: "hacker", label: "Hacker", helper: "Cheating, exploiting, automation, or impossible gameplay." },
  { value: "inappropriate_name", label: "Inappropriate name", helper: "Offensive, explicit, impersonating, or unsafe username." },
  { value: "inappropriate_profile_picture", label: "Inappropriate profile picture", helper: "Explicit, hateful, violent, or otherwise unsafe avatar." },
  { value: "other", label: "Other", helper: "Something else admins should review." },
];

interface ReportPlayerButtonProps {
  reportedClerkId?: string | null;
  reportedName?: string | null;
  gameKey: string;
  gameId?: string | number | null;
  className?: string;
}

export default function ReportPlayerButton({ reportedClerkId, reportedName, gameKey, gameId, className = "" }: ReportPlayerButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>("toxic_player");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetName = useMemo(() => reportedName?.trim() || "this player", [reportedName]);

  if (!reportedClerkId) return null;

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportedClerkId, gameKey, gameId: gameId == null ? null : String(gameId), reason, details }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.error || "Unable to submit report.");
        return;
      }
      setMessage("Report submitted. Our admins will review it soon.");
      setDetails("");
      setTimeout(() => {
        setOpen(false);
        setMessage(null);
      }, 1300);
    } catch {
      setError("Network error submitting report.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={"text-xs font-semibold text-red-300 underline decoration-red-300/40 underline-offset-4 hover:text-red-200 " + className}
      >
        Report
      </button>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <form onSubmit={submitReport} className="w-full max-w-lg rounded-2xl border border-red-400/30 bg-[#08111f] p-6 text-white shadow-2xl shadow-red-950/40">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-red-300">Player report</p>
                <h2 className="mt-1 text-2xl font-black">Report {targetName}</h2>
                <p className="mt-2 text-sm text-slate-300">Select the reason that best describes what happened in this game.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-full bg-white/10 px-3 py-1 text-sm text-slate-200 hover:bg-white/20">
                ✕
              </button>
            </div>

            <div className="grid gap-2">
              {REPORT_REASONS.map((option) => (
                <label
                  key={option.value}
                  className={"cursor-pointer rounded-xl border p-3 transition " + (reason === option.value ? "border-red-400 bg-red-500/15" : "border-white/10 bg-white/5 hover:border-white/25")}
                >
                  <div className="flex items-center gap-3">
                    <input type="radio" name="report-reason" value={option.value} checked={reason === option.value} onChange={() => setReason(option.value)} className="accent-red-400" />
                    <span className="font-bold text-slate-100">{option.label}</span>
                  </div>
                  <p className="ml-6 mt-1 text-xs text-slate-400">{option.helper}</p>
                </label>
              ))}
            </div>

            <label className="mt-4 block text-sm font-semibold text-slate-200">
              Other details
              <textarea
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                maxLength={1000}
                placeholder="Add match context, chat text, or anything admins should know..."
                className="mt-2 min-h-28 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-red-300/60"
              />
            </label>

            {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
            {message && <p className="mt-3 text-sm text-emerald-300">{message}</p>}

            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-white/10 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/20">Cancel</button>
              <button type="submit" disabled={submitting} className="rounded-lg bg-red-500 px-4 py-2 text-sm font-black text-white hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-60">
                {submitting ? "Submitting..." : "Submit report"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
