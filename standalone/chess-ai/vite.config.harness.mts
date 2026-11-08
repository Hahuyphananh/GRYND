import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// QA-only build: the self-play / tier-sweep harness. It shares the app's public
// directory (engine + licence files) but is a separate page and output, so the
// game package never ships the harness.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  build: {
    target: "es2020",
    outDir: fileURLToPath(new URL("../../dist/chess-ai-harness/", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./harness.html", import.meta.url)),
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 4321,
    strictPort: true,
  },
});
