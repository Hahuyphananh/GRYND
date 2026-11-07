// standalone/solitaire-duel/tailwind.config.cjs
//
// A SCOPED Tailwind build, not the site's. The app's own globals.css is ~4,600
// lines (light theme, mascot, chat, consent banner, ladder trees…); none of it
// belongs in a portal upload. This config scans only the standalone entry and
// the two shared Solitaire components, so the emitted CSS contains exactly the
// utilities that board uses.
//
// Absolute globs on purpose: Tailwind resolves relative patterns against the
// process CWD, which is the repo root when the build script runs.

const { join } = require("node:path");

module.exports = {
  content: [
    join(__dirname, "index.html"),
    join(__dirname, "src/**/*.{ts,tsx}"),
    join(__dirname, "../../src/components/solitaire-duel/**/*.tsx"),
  ],
  theme: { extend: {} },
  plugins: [],
};
