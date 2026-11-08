import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The standalone Chess AI game — independent of Next and of every other
// standalone build. `base: "./"` keeps every asset document-relative so the
// package runs from any portal subdirectory, which the engine worker + wasm
// also rely on.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  build: {
    target: "es2020",
    outDir: fileURLToPath(new URL("../../dist/portal/chess-ai/", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    // One chunk: the game is small and a portal loader should not have to
    // resolve extra hashed requests.
    rollupOptions: {
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 4322,
    strictPort: true,
  },
});
