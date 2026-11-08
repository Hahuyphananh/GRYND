// standalone/memory-grid/postcss.config.cjs
//
// The Tailwind config is passed EXPLICITLY. Without this, Tailwind would pick up
// the repo's root tailwind.config.js (content: ./src/**) and emit the whole
// site's utility set into the portal build.

const { join } = require("node:path");

module.exports = {
  plugins: {
    tailwindcss: { config: join(__dirname, "tailwind.config.cjs") },
    autoprefixer: {},
  },
};
