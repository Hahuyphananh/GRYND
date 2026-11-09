/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      keyframes: {
        spinIn: {
          "0%": { transform: "translateY(-100%) scale(1.2)", opacity: "0" },
          "100%": { transform: "translateY(0) scale(1)", opacity: "1" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        bounceIn: {
          "0%, 20%, 40%, 60%, 80%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" },
        },
        "coin-flip": {
          "0%": { transform: "rotateY(0)" },
          "100%": { transform: "rotateY(1440deg)" },
        },
        spinReel: {
          "0%": { transform: "translateY(-50%)", opacity: "0.5" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
      },
      animation: {
        spinIn: "spinIn 0.4s ease-out",
        fadeIn: "fadeIn 0.5s ease-in-out",
        bounceIn: "bounceIn 1s ease",
        "coin-flip": "coin-flip 1s ease-in-out",
        spinReel: "spinReel 0.3s ease-out",
      },

      // ── GRYND game-visual tokens ───────────────────────────────────────
      // Names for the custom properties declared in src/app/globals.css
      // (the "GRYND GAME VISUAL TOKENS" block). Nothing below invents a
      // colour: every entry points at a `--gr-*` property, so the palette
      // has ONE definition and the light theme can re-point a ground in
      // src/app/light-theme.css without a single utility changing here.
      //
      // Colours that need an opacity modifier are declared as
      // `rgb(var(--x-rgb))` — a bare `var(--x)` cannot take
      // `/40` in Tailwind, which wraps the value in `color-mix()`. That is why every such token carries an `-rgb`
      // triplet next to its hex.
      // Every hex token is declared in the `rgb(var(--x-rgb))`
      // form, because a plain `var(--x)` colour CANNOT take an opacity
      // modifier: `text-ink/70` would silently emit no CSS at all. v4 satisfies the modifier by wrapping the value in `color-mix(in oklab, …)`. The four
      // tokens written as `var(--x)` below are already semi-transparent
      // (rgba), so there is no modifier left to apply.
      colors: {
        brand: {
          cyan: "rgb(var(--gr-brand-cyan-rgb))",
          "cyan-soft": "rgb(var(--gr-brand-cyan-soft-rgb))",
          yellow: "rgb(var(--gr-brand-yellow-rgb))",
          gold: "rgb(var(--gr-brand-gold-rgb))",
        },
        surface: {
          page: "rgb(var(--gr-surface-page-rgb))",
          raised: "rgb(var(--gr-surface-raised-rgb))",
          panel: "rgb(var(--gr-surface-panel-rgb))",
        },
        seat: {
          1: "rgb(var(--gr-player-1-rgb))",
          2: "rgb(var(--gr-player-2-rgb))",
          neutral: "rgb(var(--gr-seat-neutral-rgb))",
        },
        state: {
          selected: "rgb(var(--gr-selected-rgb))",
          legal: "rgb(var(--gr-legal-move-rgb))",
          focus: "rgb(var(--gr-focus-ring-rgb))",
        },
        piece: {
          outline: "rgb(var(--gr-outline-rgb))",
        },
        ink: {
          DEFAULT: "rgb(var(--gr-ink-rgb))",
          muted: "var(--gr-ink-muted)",
          subtle: "var(--gr-ink-subtle)",
          "on-accent": "rgb(var(--gr-ink-on-accent-rgb))",
          disabled: "rgb(var(--gr-disabled-ink-rgb))",
        },
        // GLITCH's speech bubble — the one light surface in the app. Declared
        // in the "Mascot (GLITCH)" section of the token block in globals.css.
        mascot: {
          bubble: "rgb(var(--gr-mascot-bubble-rgb))",
          ink: "rgb(var(--gr-mascot-bubble-ink-rgb))",
        },
      },
      borderRadius: {
        cell: "var(--gr-cell-radius)",
        piece: "var(--gr-piece-radius)",
      },
      gap: {
        cell: "var(--gr-cell-gap)",
      },
      borderWidth: {
        outline: "var(--gr-outline-width)",
      },
      boxShadow: {
        piece: "var(--gr-piece-shadow)",
        glow1: "var(--gr-glow-1)",
        glow2: "var(--gr-glow-2)",
        frame: "var(--gr-frame-shadow)",
        "frame-inset": "var(--gr-frame-inset)",
      },
      transitionDuration: {
        fast: "var(--gr-duration-fast)",
        base: "var(--gr-duration-base)",
        slow: "var(--gr-duration-slow)",
      },
      transitionTimingFunction: {
        standard: "var(--gr-ease-standard)",
        pop: "var(--gr-ease-pop)",
      },
    },
  },
  plugins: [],
};
