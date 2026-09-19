"use client";

// ── Render-error containment for the Precision match page ────────────────
//
// The match page is a long-lived, socket/poll-driven surface: a fresh server
// snapshot is swapped in every couple of seconds and drives a lot of derived
// UI. A single bad read used to bubble to the App Router's error overlay and
// leave the player on a blank screen (the reported \"client-side exception\"
// / blank page). React error boundaries only catch RENDER/lifecycle throws,
// which is exactly where this page is fragile, so wrapping the page means a
// bad frame degrades to a recoverable panel instead of a dead URL.
//
// Deliberately self-contained: no hooks, no context, no i18n (a boundary may
// be rendering because the tree around it is broken, so it must depend on
// nothing but React). Plain English on purpose for a crash fallback.

import React from "react";

interface PrecisionMatchErrorBoundaryProps {
  children: React.ReactNode;
}

interface PrecisionMatchErrorBoundaryState {
  hasError: boolean;
}

export default class PrecisionMatchErrorBoundary extends React.Component<
  PrecisionMatchErrorBoundaryProps,
  PrecisionMatchErrorBoundaryState
> {
  state: PrecisionMatchErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PrecisionMatchErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    // Keep the diagnostic in the console/Sentry instead of the user's face.
    console.error("[precision] match page render error:", error, info);
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
    if (typeof window !== "undefined") window.location.reload();
  };

  private handleLobby = () => {
    if (typeof window !== "undefined") window.location.assign("/casino/precision");
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#06120f] to-[#050816] px-4 text-white">
        <div className="w-full max-w-md rounded-2xl border border-red-400/40 bg-red-500/10 p-6 text-center">
          <p className="text-3xl">⚠️</p>
          <h1 className="mt-3 text-xl font-black text-red-200">
            This Precision match hit a snag
          </h1>
          <p className="mt-2 text-sm text-red-100/90">
            The board stopped rendering. Your match state is safe on the server —
            reload to reconnect, or head back to the lobby.
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-xl bg-[#f5ff3b] px-5 py-2.5 font-black text-black transition hover:brightness-110"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.handleLobby}
              className="rounded-xl border border-white/20 bg-white/5 px-5 py-2.5 font-bold text-white transition hover:bg-white/10"
            >
              Back to lobby
            </button>
          </div>
        </div>
      </div>
    );
  }
}
