// standalone/solitaire-duel/src/globals.d.ts
//
// The build-time constants Vite substitutes (see vite.config.mts `define`).
//
// They are declared here rather than read from `import.meta.env` so the module
// that consumes them stays importable outside Vite (the test suite imports it to
// prove the CTA's default), and so the repo's own `tsc` pass needs no Vite types.

declare const __GRYND_CTA_ENABLED__: boolean;
declare const __GRYND_CTA_URL__: string;

/** `"none"` unless the build was asked for a specific portal SDK adapter. */
declare const __PORTAL_SDK__: "none" | "crazygames";
