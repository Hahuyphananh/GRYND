// standalone/solitaire-duel/postcss.config.cjs
//
// The Tailwind config is passed EXPLICITLY. Without this, Tailwind would pick up
// the repo's root tailwind.config.js (content: ./src/**) and emit the whole
// site's utility set into the portal build.

// Tailwind v4: the plugin is `@tailwindcss/postcss`, and the config is named by
// the `@config` directive in src/theme.css (which keeps this build scoped to the
// standalone globs instead of the repo's root config).
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
