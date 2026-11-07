// standalone/solitaire-duel/vite.config.mts
//
// The isolated build for the uploadable Solitaire Duel. It is deliberately
// separate from Next: `npm run build:portal:solitaire` produces a plain folder
// (index.html + hashed JS + hashed CSS) that runs from any static host,
// including a portal's own CDN.
//
// `base: "./"` matters for portals: an upload is served from a path nobody can
// predict, so every asset reference must be document-relative, never "/assets".
//
// THE GRYND CTA IS A BUILD-TIME DECISION, not a runtime one. `PORTAL_CTA` and
// `PORTAL_CTA_URL` are read here (from the environment, or from
// `standalone/solitaire-duel/.env`) and folding into the bundle as constants.
// With no configuration the CTA is OFF and no GRYND URL exists anywhere in the
// output — which is the default every portal gets.
//
//   PORTAL_CTA=on PORTAL_CTA_URL=https://www.grynd.dedyn.io/sign-in npm run build:portal:solitaire
//
// THE PORTAL SDK IS ALSO BUILD-TIME, and off unless `PORTAL_SDK` names one.
// Only CrazyGames has an adapter (`src/portal-sdk.ts`). An SDK build fetches the
// portal's own script at runtime, so it is the ONE exception to the package's
// "no external requests" rule — and it is refused together with the CTA,
// because CrazyGames does not allow promoting an outside account/product in-game.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/** Truthy spellings for `PORTAL_CTA`. Anything else means "disabled". */
const isOn = (value: unknown) => /^(1|true|on|yes|enabled)$/i.test(String(value ?? "").trim());

export default defineConfig(({ mode }) => {
  // `PORTAL_` prefixed vars may live in standalone/solitaire-duel/.env; real
  // process env always wins, so CI can flip it without a file.
  const env = { ...loadEnv(mode, here, "PORTAL_"), ...process.env };

  // A CTA needs BOTH the switch and an absolute https destination. A missing or
  // non-https URL leaves it off, so a typo can never ship a broken outbound link
  // (or a relative one that would leave the portal's CDN).
  const requestedUrl = String(env.PORTAL_CTA_URL ?? "").trim();
  const ctaEnabled = isOn(env.PORTAL_CTA) && /^https:\/\/[^\s]+$/i.test(requestedUrl);

  const portalSdk = String(env.PORTAL_SDK ?? "none").trim().toLowerCase() || "none";
  if (portalSdk !== "none" && portalSdk !== "crazygames") {
    throw new Error(`PORTAL_SDK must be "none" or "crazygames" (received "${portalSdk}").`);
  }
  if (portalSdk === "crazygames" && ctaEnabled) {
    // Not a technical limit: a policy one. CrazyGames forbids promoting an
    // external account or product inside a submitted game, so a build that did
    // both could not pass review. Refuse rather than ship it silently.
    throw new Error(
      "PORTAL_CTA cannot be enabled in a PORTAL_SDK=crazygames build — CrazyGames prohibits outbound promotion. Drop PORTAL_CTA for this package.",
    );
  }

  return {
    root: here,
    base: "./",
    // `public/` holds the icon set only (favicon.ico/.svg, apple-touch-icon,
    // icon-512). Vite copies it to the output root, so the package stays a
    // self-contained folder with no asset path outside it.
    publicDir: resolve(here, "public"),
    define: {
      __GRYND_CTA_ENABLED__: JSON.stringify(ctaEnabled),
      __GRYND_CTA_URL__: JSON.stringify(ctaEnabled ? requestedUrl : ""),
      __PORTAL_SDK__: JSON.stringify(portalSdk),
    },
    build: {
      // The package the portal receives: index.html at ITS root, assets beside it.
      outDir: resolve(here, "../../dist/portal/solitaire-duel"),
      // outDir is outside this project root, so Vite needs this explicitly to
      // clear a previous build instead of warning and leaving stale hashes.
      emptyOutDir: true,
      target: "es2020",
      assetsDir: "assets",
      sourcemap: false,
      // One chunk: the game is small, and a portal's loader must not have to
      // resolve extra requests with unpredictable names.
      rollupOptions: {
        output: {
          manualChunks: undefined,
          inlineDynamicImports: true,
        },
      },
    },
    server: {
      port: 4319,
      strictPort: true,
    },
  };
});
