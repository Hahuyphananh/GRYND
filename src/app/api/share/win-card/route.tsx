// src/app/api/share/win-card/route.tsx
//
// GET — the win card as a PNG, for og:image.
//
// A shared result links to /share/win?…; that page's metadata points here, so a
// social crawler fetches the actual run's card instead of the site's generic
// artwork. The numbers are the same ones the share text names: both are built
// from lib/shareWin.ts, so the preview, the page and the post cannot drift.
//
// PUBLIC AND PARAMETERISED, so the input is UNTRUSTED and validated: every
// field is narrowed by parseShareCardQuery (game/mode allowlisted, duration
// clamped to a day, moves bounded, badge restricted to PRO/FOUNDER) before it
// reaches the renderer. Nothing here reads the database or the session — a card
// is a picture of a claim, not a verification of one.
//
// Cached: the URL fully describes the image, so it can be held at the edge and
// re-rendered only when it changes.

import { ImageResponse } from "next/og";

import {
  SHARE_CARD_MAX_MS,
  parseShareCardQuery,
  shareBadgeLabel,
  shareGameLabel,
  shareModeLabel,
  shareMovesLabel,
  shareSolvedLabel,
  shareTimeLabel,
} from "../../../../lib/shareWin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { input, locale } = parseShareCardQuery(new URL(request.url).searchParams);

  const game = shareGameLabel(input.game, locale).toUpperCase();
  const mode = (shareModeLabel(input.mode, locale) ?? shareSolvedLabel(locale)).toUpperCase();
  const time = shareTimeLabel(input.durationMs) ?? "WIN";
  const moves = shareMovesLabel(input.moves, locale);
  const badge = shareBadgeLabel(input.badge);

  const durationMs = Number(input.durationMs);
  const clamped =
    Number.isFinite(durationMs) && durationMs > 0
      ? Math.min(Math.round(durationMs), SHARE_CARD_MAX_MS)
      : null;

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 54, fontWeight: 900, letterSpacing: -1 }}>
              GRYND
            </div>
            <div style={{ display: "flex", width: 96, height: 5, background: "#34d399", marginTop: 12 }} />
          </div>
          {badge ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                border: "2px solid rgba(52, 211, 153, 0.55)",
                background: "rgba(52, 211, 153, 0.16)",
                color: "#34d399",
                borderRadius: 999,
                padding: "12px 26px",
                fontSize: 26,
                fontWeight: 800,
              }}
            >
              {badge}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              color: "#8fa3bf",
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: 2,
            }}
          >
            {`${game}  ·  ${mode}`}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 178,
              fontWeight: 900,
              lineHeight: 1,
              marginTop: 8,
              color: "#ffffff",
            }}
          >
            {time}
          </div>
          {moves ? (
            <div
              style={{
                display: "flex",
                fontSize: 30,
                fontWeight: 700,
                color: "rgba(226, 232, 240, 0.72)",
                marginTop: 6,
              }}
            >
              {moves}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", color: "#8fa3bf", fontSize: 26, fontWeight: 600 }}>
          grynd.dedyn.io  ·  #GRYND
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      // The query IS the image, so a cached render is always correct; a day is
      // long enough to keep crawlers cheap and short enough to ship a redesign.
      headers: {
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    },
  );
}
