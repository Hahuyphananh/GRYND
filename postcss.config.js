// Tailwind v4 runs as its OWN PostCSS plugin (`@tailwindcss/postcss`) and
// vendor-prefixes through Lightning CSS, so autoprefixer is no longer part of
// the chain — a second pass over the same output would just cost build time.
// The theme/config is still the repo's JS config; the stylesheet opts into it
// with `@config` (see src/app/globals.css).
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
