// standalone/memory-grid/src/globals.d.ts
//
// The three build-time constants `vite.config.mts` folds into the bundle. They
// are declared here so the source type-checks outside Vite (in the test suite)
// where they do not exist at all — every read is guarded with `typeof`.

declare const __GRYND_CTA_ENABLED__: boolean;
declare const __GRYND_CTA_URL__: string;
declare const __PORTAL_SDK__: string;
