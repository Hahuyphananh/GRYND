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

/**
 *  Closed fist — the RPS "rock" throw. Reads unmistakably as a fist
 *  (unlike Tabler's IconHandGrab, whose fingers are extended). Adapted
 *  from Lucide's hand-fist icon (ISC license), restyled to Tabler's
 *  visual language (24×24 viewBox, 1.8 stroke, round caps) so it
 *  inherits the same currentColor strokes and glow shadows.
 */
export function RockFistIcon(props: CustomIconProps) {
  return (
    <svg {...baseProps(props)}>
      {/* palm + curled fingers */}
      <path d="M12.035 17.012a3 3 0 0 0-3-3l-.311-.002a.72.72 0 0 1-.505-1.229l1.195-1.195A2 2 0 0 1 10.828 11H12a2 2 0 0 0 0-4H9.243a3 3 0 0 0-2.122.879l-2.707 2.707A4.83 4.83 0 0 0 3 14a8 8 0 0 0 8 8h2a8 8 0 0 0 8-8V7a2 2 0 1 0-4 0v2a2 2 0 1 0 4 0" />
      {/* knuckles / finger segments */}
      <path d="M13.888 9.662A2 2 0 0 0 17 8V5a2 2 0 1 0-4 0M9 5a2 2 0 1 0-4 0v5m4-3V4a2 2 0 1 1 4 0v3.268" />
    </svg>
  );
}

