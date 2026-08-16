// src/components/icons/CustomIcons.tsx
//
// Custom SVG icons for glyphs that have no @tabler/icons-react equivalent
// (slot machine, pool/billiards ball, chicken). They mimic Tabler's
// visual language: 24x24 viewBox, 1.8 stroke, round caps/joins, and
// `currentColor` strokes so they inherit the same Tailwind text colors
// and glow shadows as every other icon in the app.
import type { SVGProps } from "react";

type CustomIconProps = Omit<SVGProps<SVGSVGElement>, "stroke" | "width" | "height"> & {
  size?: string | number;
  stroke?: string | number;
};

function baseProps({ size = 24, stroke = 1.8, ...rest }: CustomIconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: String(stroke),
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...rest,
  };
}

/**  Billiards 8-ball — ball outline with the white top stripe and number circle. */
export function PoolBallIcon(props: CustomIconProps) {
  return (
    <svg {...baseProps(props)}>
      <circle cx="12" cy="12" r="9" />
      {/* white stripe arc across the top */}
      <path d="M8.1 8.2a5.5 5.5 0 0 1 7.8 0" />
      {/* the "8" */}
      <circle cx="12" cy="14.6" r="2" />
      <path d="M11 13.6h.01M13 13.6h.01M11.2 15.4h1.6" />
    </svg>
  );
}

