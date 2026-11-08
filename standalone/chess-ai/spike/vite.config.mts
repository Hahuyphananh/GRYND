import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Phase 1 spike build — deliberately independent of the Next app and of the
// other standalone games. `base: "./"` is load-bearing: portal hosting serves a
// game from a subdirectory, so the page, its assets, the worker script and the
// wasm must all resolve relative to index.html.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  // The engine assets live with the app (they are its shipping assets), so the
  // spike and the app serve ONE copy rather than two.
  publicDir: fileURLToPath(new URL("../public", import.meta.url)),
  build: {
    target: "es2020",
    outDir: fileURLToPath(new URL("../../../dist/chess-ai-spike/", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
