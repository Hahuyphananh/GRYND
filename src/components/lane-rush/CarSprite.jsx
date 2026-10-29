"use client";

// src/components/lane-rush/CarSprite.jsx
//
// The ONE car artwork component, shared by the oval track, the fleet panel and
// the merge animation.
//
// It renders the tier's public PNG through a viewBox set to the asset's
// measured CONTENT FRAME, so the transparent canvas around the car is cropped
// away and the artwork itself fills the sprite box at its true aspect ratio.
// Without that crop the raw 256 × 256 render put a ~45%-wide car inside a
// square box, which is what made track cars read as dots.
//
// A seat-coloured glow is drawn *behind* the artwork (blue = Player 1, red =
// Player 2); the car's own paint is never tinted. If the image is missing or
// fails to load, a neutral tier chip keeps the slot readable instead of leaving
// a hole — that fallback is an error state, never the normal rendering.

import { useEffect, useId, useState } from "react";
import { CAR_SPRITE_CANVAS, carSpriteFor, carSpriteSize } from "./carSprites";

const SEAT_GLOW = Object.freeze({
  player1: "#38bdf8",
  player2: "#fb7185",
});

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const round1 = (value) => Math.round(value * 10) / 10;

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
  const frame = sprite.frame;
  const aspect = frame.height / frame.width;

  // `width` + `height` is the track's aspect-true box; `size` is the square box
  // the garage and the merge replay use; a bare tier falls back to its width.
  const explicitWidth = positive(width);
  const explicitHeight = positive(height);
  const square = positive(size);
  const boxWidth = explicitWidth ?? square ?? carSpriteSize(tier);
  const boxHeight =
    explicitHeight ?? (square && !explicitWidth ? square : round1(boxWidth * aspect));

  const [failed, setFailed] = useState(false);
  const gradientId = `laneRushGlow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const glow = seat ? SEAT_GLOW[seat] || null : null;
  const frameCx = frame.x + frame.width / 2;
  const frameCy = frame.y + frame.height / 2;

  // A src change is a new asset: give it a fresh chance to load.
  useEffect(() => {
    setFailed(false);
  }, [sprite.src]);

  const accessibility = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true, focusable: "false" };

  return (
    <svg
      width={boxWidth}
      height={boxHeight}
      // The content frame IS the viewBox: the transparent margins live outside
      // it and are clipped, so the car is scaled to the box, not to the canvas.
      viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
      className={className}
      style={style}
      {...accessibility}
    >
      {label ? <title>{label}</title> : null}

      {glow ? (
        <>
          <defs>
            <radialGradient id={gradientId}>
              <stop offset="42%" stopColor={glow} stopOpacity="0.42" />
              <stop offset="74%" stopColor={glow} stopOpacity="0.18" />
              <stop offset="100%" stopColor={glow} stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse
            cx={frameCx}
            cy={frameCy}
            rx={frame.width / 2}
            ry={frame.height / 2}
            fill={`url(#${gradientId})`}
          />
        </>
      ) : null}

      {!failed ? (
        <image
          href={sprite.src}
          x={0}
          y={0}
          width={CAR_SPRITE_CANVAS.width}
          height={CAR_SPRITE_CANVAS.height}
          preserveAspectRatio="none"
          onError={() => setFailed(true)}
          onLoad={() => setFailed(false)}
        />
      ) : (
        <g>
          <rect
            x={frame.x}
            y={frame.y}
            width={frame.width}
            height={frame.height}
            rx={frame.width * 0.14}
            fill="#0b1220"
            stroke={glow || "#94a3b8"}
            strokeWidth={frame.width * 0.03}
          />
          <text
            x={frameCx}
            y={frameCy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={frame.width * 0.62}
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
