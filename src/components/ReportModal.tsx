"use client";

import { useState, type ReactNode } from "react";
import {
  IconCircleCheck,
  IconEdit,
  IconIdBadge,
  IconMoodAngry,
  IconPhoto,
  IconRobot,
} from "@tabler/icons-react";

export type ReportReason =
  | "toxic_player"
  | "hacker"
  | "inappropriate_name"
  | "inappropriate_picture"
  | "other";

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (reason: ReportReason, details: string) => Promise<void>;
  reportedPlayerName: string;
  gameType: string;
}

const REASONS: { value: ReportReason; label: string; description: string; icon: ReactNode }[] = [
  {
    value: "toxic_player",
    label: "Toxic Player",
    description: "Harassment, abusive chat, or unsportsmanlike behavior",
    icon: <IconMoodAngry size={22} />,
  },
  {
    value: "hacker",
    label: "Hacker / Cheater",
    description: "Suspicious gameplay, exploits, or unfair advantages",
    icon: <IconRobot size={22} />,
  },
  {
    value: "inappropriate_name",
    label: "Inappropriate Name",
    description: "Offensive, hateful, or inappropriate username",
    icon: <IconIdBadge size={22} />,
  },
  {
    value: "inappropriate_picture",
    label: "Inappropriate Picture",
    description: "Offensive, explicit, or inappropriate profile picture",
    icon: <IconPhoto size={22} />,
  },
  {
    value: "other",
    label: "Other",
    description: "Any other issue. Please provide details",
    icon: <IconEdit size={22} />,
  },
];

export default function ReportModal({
  isOpen,
  onClose,
  onSubmit,
  reportedPlayerName,
  gameType,
}: ReportModalProps) {
  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!selectedReason) {
      setError("Please select a reason for reporting");
      return;
    }

    if (selectedReason === "other" && !details.trim()) {
      setError("Please provide details for your report");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await onSubmit(selectedReason, details.trim());
      setSubmitted(true);
    } catch (err: any) {
      // `fetch()` throws a TypeError ("Failed to fetch" / "Load failed" /
      // "NetworkError") when the user has no internet, the browser blocks
      // the request, or a CORS/preflight check fails. Restrict the message
      // match to real fetch TypeErrors so a server-supplied error string
      // containing these substrings can't falsely trip the offline branch.
      const raw = String(err?.message ?? "").toLowerCase();
      const fetchNetworkError =
        err instanceof TypeError &&
        (raw.includes("failed to fetch") ||
          raw.includes("networkerror") ||
          raw.includes("load failed") ||
          raw.includes("network request failed"));
      if (fetchNetworkError || navigator.onLine === false) {
        setError(
          "You appear to be offline. Please check your internet connection and try again.",
        );
      } else {
        setError(err?.message || "Failed to submit report. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setSelectedReason(null);
    setDetails("");
    setError(null);
    setSubmitted(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Report Player">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 p-6
        bg-gradient-to-b from-[#0f172a] via-[#1e293b] to-[#0f172a]
        shadow-[0_0_60px_rgba(239,68,68,0.15)]">
        {submitted ? (
          /* ── Success state ── */
          <div className="text-center py-4">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <IconCircleCheck size={30} className="text-emerald-400" />
            </div>
            <h2 className="text-xl font-bold text-emerald-400 mb-2">Report Submitted</h2>
            <p className="text-sm text-slate-400 mb-6">
              Thank you for your report. Our moderation team will review it and take appropriate action.
            </p>
            <button
              onClick={handleClose}
              className="w-full rounded-xl py-2.5 text-sm font-bold bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-lg font-bold text-white">Report Player</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Report <span className="text-red-400 font-semibold">{reportedPlayerName}</span> from{" "}
                  <span className="text-slate-300">{gameType}</span>
                </p>
              </div>
              <button
                onClick={handleClose}
                className="text-slate-500 hover:text-white transition-colors p-1"
                aria-label="Close"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            </div>

            {/* Error */}
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* Reasons */}
            <div className="mb-5 space-y-2">
              <p className="text-xs text-slate-500 uppercase tracking-widest mb-2">Select a reason</p>
              {REASONS.map((reason) => (
                <button
                  key={reason.value}
                  onClick={() => {
                    setSelectedReason(reason.value);
                    setError(null);
                  }}
                  className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all duration-200 ${
                    selectedReason === reason.value
                      ? "border-red-500/50 bg-red-500/10 shadow-[0_0_12px_rgba(239,68,68,0.15)]"
                      : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]"
                  }`}
                >
                  <span className="text-xl flex-shrink-0">{reason.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold ${selectedReason === reason.value ? "text-red-300" : "text-white"}`}>
                      {reason.label}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{reason.description}</p>
                  </div>
                  <span
                    className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                      selectedReason === reason.value
                        ? "border-red-500 bg-red-500"
                        : "border-white/20"
                    }`}
                  >
                    {selectedReason === reason.value && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M2 5l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                </button>
              ))}
            </div>

            {/* Details textarea for "other" */}
            {selectedReason === "other" && (
              <div className="mb-5 animate-in fade-in slide-in-from-top-2 duration-200">
                <label className="text-xs text-slate-500 uppercase tracking-widest block mb-2">
                  Additional Details
                </label>
                <textarea
                  value={details}
                  onChange={(e) => {
                    setDetails(e.target.value);
                    setError(null);
                  }}
                  placeholder="Describe the issue in detail..."
                  rows={4}
                  maxLength={500}
                  className="w-full rounded-xl bg-[#020617] border border-white/15 px-4 py-3 text-white text-sm
                    focus:border-red-400/50 focus:ring-1 focus:ring-red-400/30 outline-none transition resize-none
                    placeholder:text-slate-500"
                />
                <p className="text-[10px] text-slate-500 mt-1 text-right">{details.length}/500</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 rounded-xl py-2.5 text-sm font-bold border border-white/15 text-slate-300 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !selectedReason}
                className="flex-1 rounded-xl py-2.5 text-sm font-bold bg-red-600/80 hover:bg-red-600 text-white
                  transition-all disabled:opacity-40 disabled:cursor-not-allowed
                  shadow-[0_0_16px_rgba(239,68,68,0.3)]"
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-block w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Submitting...
                  </span>
                ) : (
                  "Submit Report"
                )}
              </button>
            </div>

            <p className="mt-4 text-[9px] text-slate-600 text-center">
              False reports may result in action against your account. Reports are reviewed by our moderation team.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
