"use client";

// src/components/lane-rush/CarSprite.jsx
//
// The ONE car artwork component, shared by the oval track, the fleet panel and
// the merge animation.
//
// It renders a square SVG that holds the tier's public PNG, so it works both
// inside the track's <svg> and as an HTML thumbnail. A seat-coloured glow is
// drawn *behind* the artwork (blue = Player 1, red = Player 2); the car's own
// paint is never tinted. If the image is missing or fails to load, a tier token
// keeps the slot readable instead of leaving a hole.

import { useEffect, useId, useState } from "react";
import { carSpriteFor, carSpriteSize } from "./carSprites";

const SEAT_GLOW = Object.freeze({
  player1: "#38bdf8",
  player2: "#fb7185",
});

export default function CarSprite({
  tier = 1,
  damaged = false,
  size,
  width,
  height,
  seat = null,
  label = null,
  className = "",
  style = null,
}) {
  const sprite = carSpriteFor({ tier, damaged });
  const box = Number(size) > 0 ? Number(size) : carSpriteSize(tier);
  const renderedWidth = Number(width) > 0 ? Number(width) : box;
  const renderedHeight = Number(height) > 0 ? Number(height) : box;
  const [failed, setFailed] = useState(false);
  const gradientId = `laneRushGlow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const glow = seat ? SEAT_GLOW[seat] || null : null;

  // A src change is a new asset: give it a fresh chance to load.
  useEffect(() => {
    setFailed(false);
  }, [sprite.src]);

  const accessibility = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true, focusable: "false" };

  return (
    <svg
      width={renderedWidth}
      height={renderedHeight}
      viewBox="0 0 100 100"
      className={className}
      style={style}
      {...accessibility}
    >
      {label ? <title>{label}</title> : null}

      {glow ? (
        <>
          <defs>
            <radialGradient id={gradientId}>
              <stop offset="35%" stopColor={glow} stopOpacity="0.45" />
              <stop offset="72%" stopColor={glow} stopOpacity="0.16" />
              <stop offset="100%" stopColor={glow} stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="50" cy="50" r="50" fill={`url(#${gradientId})`} />
        </>
      ) : null}

      {!failed ? (
        <image
          href={sprite.src}
          x="0"
          y="0"
          width="100"
          height="100"
          preserveAspectRatio="xMidYMid meet"
          onError={() => setFailed(true)}
          onLoad={() => setFailed(false)}
        />
      ) : (
        <g>
          <circle
            cx="50"
            cy="50"
            r="34"
            fill="#0b1220"
            stroke={glow || "#94a3b8"}
            strokeWidth="4"
          />
          <circle
            cx="50"
            cy="50"
            r="26"
            fill="none"
            stroke={glow || "#94a3b8"}
            strokeOpacity="0.55"
            strokeWidth="2"
          />
          <text
            x="50"
            y="50"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="30"
            fontWeight="900"
            fill="#e2e8f0"
          >
            {sprite.tier}
          </text>
        </g>
      )}
    </svg>
  );
}
