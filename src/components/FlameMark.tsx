// src/components/FlameMark.tsx
//
// The streak's flame, drawn as a small app-icon tile: a dark flame on the
// reward yellow. It exists so the streak never leans on an emoji — an emoji
// renders differently on every OS (and some Android builds ship no colour
// glyph at all), while this reads as a favicon at 28px and at 40px.

export default function FlameMark({ size = 40 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-testid="daily-streak-flame"
      className="flex shrink-0 items-center justify-center rounded-lg border border-[#f5ff3b]/60 bg-[#f5ff3b] shadow-[0_0_18px_rgba(245,255,59,0.45)]"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12.4 2.1c.5 3.5-1.1 5.4-2.8 7-1.5 1.4-3 2.9-3 5.4 0 2.8 2.1 5 5.5 5s6-2.3 6-5.6c0-2.3-1.1-4.1-2.7-5.6-.5 1.7-1.3 2.7-2.4 3.2.4-3.2-.3-6.5-1.6-9.4Z"
          fill="#10130a"
        />
        <path
          d="M12.1 13.2c1.4 1.1 2.1 2.2 2.1 3.5 0 1.4-1 2.4-2.3 2.4s-2.3-1-2.3-2.4c0-1.2.6-2.1 1.5-3 .3.7.6 1.2 1 1.5Z"
          fill="#f5ff3b"
        />
      </svg>
    </span>
  );
}
