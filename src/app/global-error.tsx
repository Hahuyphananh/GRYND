"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Last-resort error screen — shown when the ROOT layout itself throws.
 *
 * It replaces the root layout, so none of the app's CSS or providers are
 * available (no Tailwind, no LanguageProvider). Everything here is therefore
 * inline-styled and self-contained. Keep it dependency-free.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#030817",
          color: "#d8fbff",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          padding: "24px",
        }}
      >
        <div
          role="alert"
          style={{
            width: "100%",
            maxWidth: "440px",
            textAlign: "center",
            border: "1px solid rgba(248,113,113,0.4)",
            background: "rgba(26,11,22,0.9)",
            borderRadius: "14px",
            padding: "32px 24px",
            boxShadow: "0 0 28px rgba(0,229,255,0.08)",
          }}
        >
          <div style={{ fontSize: "40px", lineHeight: 1, marginBottom: "12px" }}>
            ⚠️
          </div>
          <h1
            style={{
              margin: "0 0 8px",
              fontSize: "20px",
              fontWeight: 700,
              color: "#fecaca",
            }}
          >
            GRYND hit an unexpected problem
          </h1>
          <p style={{ margin: "0 0 20px", fontSize: "14px", color: "#9dd8ff" }}>
            The app failed to start properly. Retrying usually fixes it.
          </p>

          <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                cursor: "pointer",
                border: "1px solid rgba(248,113,113,0.5)",
                background: "rgba(239,68,68,0.2)",
                color: "#fee2e2",
                borderRadius: "10px",
                padding: "10px 20px",
                fontSize: "14px",
                fontWeight: 600,
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                display: "inline-block",
                border: "1px solid rgba(0,229,255,0.5)",
                background: "#0a214d",
                color: "#00e5ff",
                borderRadius: "10px",
                padding: "10px 20px",
                fontSize: "14px",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Back to home
            </a>
          </div>

          {error?.digest && (
            <p style={{ marginTop: "18px", fontSize: "12px", color: "#6b91b3" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
