// src/lib/surfaceCardImage.tsx
//
// One shape for the per-surface social cards: the daily challenge, the daily
// and unlimited puzzles, the Play hub and its AI lobby, and the solo and ranked
// lobbies.
//
// Each surface has its own page and its own identity, so each gets its own
// 1200×630 card rather than the site's generic banner: a crawler that fetches
// /daily, /play/daily-puzzle or /play/unlimited-puzzles should render a preview
// that says which one it is. The differences are the accent colour,
// the kicker and the three lines of substance — everything else (frame, ground,
// wordmark, footer) is shared, so the three read as one family.
//
// Rendered by the `opengraph-image.tsx` files next to those routes, which Next
// wires into og:image automatically. Parameters are literals in those files, so
// there is nothing untrusted to validate here.

import { ImageResponse } from "next/og";

/** The landscape size X, Facebook, LinkedIn and Slack expect for a preview. */
export const SURFACE_CARD_SIZE = { width: 1200, height: 630 } as const;

export type SurfaceCardSpec = {
  /** Small label above the title, e.g. "DAILY PUZZLE". */
  kicker: string;
  /** The headline claim. */
  title: string;
  /** One sentence of what the surface is. */
  subtitle: string;
  /** Up to three short facts (allowance, reset, attempt rule). */
  points: readonly string[];
  /** Accent colour for the kicker, the rule and the point bullets. */
  accent: string;
};

export function surfaceCardResponse({
  kicker,
  title,
  subtitle,
  points,
  accent,
}: SurfaceCardSpec) {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #071226 0%, #04070f 55%, #02060d 100%)",
          padding: 72,
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 48, fontWeight: 900, letterSpacing: -1 }}>
              GRYND
            </div>
            <div style={{ display: "flex", width: 96, height: 5, background: accent, marginTop: 12 }} />
          </div>
          <div
            style={{
              display: "flex",
              border: `2px solid ${accent}`,
              color: accent,
              borderRadius: 999,
              padding: "10px 24px",
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: 4,
            }}
          >
            {kicker}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 78, fontWeight: 900, lineHeight: 1.02 }}>
            {title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              color: "rgba(226, 232, 240, 0.75)",
              marginTop: 14,
            }}
          >
            {subtitle}
          </div>
          <div style={{ display: "flex", gap: 26, marginTop: 26 }}>
            {points.map((point) => (
              <div
                key={point}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 22,
                  fontWeight: 700,
                  color: "rgba(226, 232, 240, 0.9)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: accent,
                  }}
                />
                {point}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", color: "#8fa3bf", fontSize: 24, fontWeight: 600 }}>
          grynd.dedyn.io  ·  #GRYND
        </div>
      </div>
    ),
    {
      ...SURFACE_CARD_SIZE,
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    },
  );
}
