// .eslintrc.no-undef.cjs
//
// A focused gate for the one class of bug the app has actually shipped twice:
// a call site naming a symbol that no file defines (`selectTab is not defined`
// on the leaderboard, `userId is not defined` in the UNO join route). The
// build does not catch it — webpack only rewrites imports, so a bare identifier
// survives into the bundle and throws at runtime.
//
// Deliberately narrow: `no-undef` and nothing else, so this script fails only
// on undefined references and never on style. TypeScript is already covered by
// `npm run typecheck`; this covers the JS/JSX files it does not check.
//
// Run with: npm run lint:no-undef

module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  rules: {
    "no-undef": "error",
  },
  ignorePatterns: ["node_modules/", ".next/", ".open-next/", "dist/"],
};
