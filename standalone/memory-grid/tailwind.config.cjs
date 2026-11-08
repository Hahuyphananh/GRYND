// standalone/memory-grid/tailwind.config.cjs
//
// A SCOPED Tailwind build, not the site's. The app's globals.css is ~4,600 lines
// (light theme, mascot, chat, consent banner, ladder trees…); none of it belongs
// in a portal upload. This config scans only the standalone entry, so the
// emitted CSS contains exactly the utilities these screens use.
//
// Absolute globs on purpose: Tailwind resolves relative patterns against the
// process CWD, which is the repo root when the build script runs.
//
// Any shared production component the board later imports must be added here
// too, or its classes are stripped.

const { join } = require("node:path");

module.exports = {
  content: [join(__dirname, "index.html"), join(__dirname, "src/**/*.{ts,tsx}")],
  theme: { extend: {} },
  plugins: [],
};
