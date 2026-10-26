// .eslintrc.cjs
//
// The application does not currently commit an ESLint configuration (and
// `next lint` was removed in Next 16), so the CI lint gate is scoped to the
// release/deployment code, which is plain Node ESM. `npm run typecheck` covers
// the app's TypeScript.
//
// Keep this file small: adding the app to ESLint is a separate, reviewed change.

module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parserOptions: { ecmaVersion: 2023, sourceType: "module" },
  extends: ["eslint:recommended"],
  ignorePatterns: [
    "node_modules/",
    ".next/",
    "dist/",
    "deploy/staging/fixture/**",
  ],
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-console": "off",
  },
};
