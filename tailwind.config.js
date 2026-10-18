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
      // `rgb(var(--x-rgb) / <alpha-value>)` — a bare `var(--x)` cannot take
      // `/40` in Tailwind. That is why every such token carries an `-rgb`
      // triplet next to its hex.
      // Every hex token is declared in the `rgb(var(--x-rgb) / <alpha-value>)`
      // form, because a plain `var(--x)` colour CANNOT take an opacity
      // modifier: `text-ink/70` would silently emit no CSS at all. The four
      // tokens written as `var(--x)` below are already semi-transparent
      // (rgba), so there is no modifier left to apply.
      colors: {
        brand: {
          cyan: "rgb(var(--gr-brand-cyan-rgb) / <alpha-value>)",
          "cyan-soft": "rgb(var(--gr-brand-cyan-soft-rgb) / <alpha-value>)",
          yellow: "rgb(var(--gr-brand-yellow-rgb) / <alpha-value>)",
          gold: "rgb(var(--gr-brand-gold-rgb) / <alpha-value>)",
        },
        surface: {
          page: "rgb(var(--gr-surface-page-rgb) / <alpha-value>)",
          raised: "rgb(var(--gr-surface-raised-rgb) / <alpha-value>)",
          panel: "rgb(var(--gr-surface-panel-rgb) / <alpha-value>)",
        },
        seat: {
          1: "rgb(var(--gr-player-1-rgb) / <alpha-value>)",
          2: "rgb(var(--gr-player-2-rgb) / <alpha-value>)",
          neutral: "rgb(var(--gr-seat-neutral-rgb) / <alpha-value>)",
        },
        state: {
          selected: "rgb(var(--gr-selected-rgb) / <alpha-value>)",
          legal: "rgb(var(--gr-legal-move-rgb) / <alpha-value>)",
          focus: "rgb(var(--gr-focus-ring-rgb) / <alpha-value>)",
        },
        piece: {
          outline: "rgb(var(--gr-outline-rgb) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--gr-ink-rgb) / <alpha-value>)",
          muted: "var(--gr-ink-muted)",
          subtle: "var(--gr-ink-subtle)",
          "on-accent": "rgb(var(--gr-ink-on-accent-rgb) / <alpha-value>)",
          disabled: "rgb(var(--gr-disabled-ink-rgb) / <alpha-value>)",
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
