import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the built site works from any host and sub-path.
  base: "./",
  plugins: [react()],
  assetsInclude: ["**/*.binpb"],
  // The browser watchtower's Web Worker (src/replay/worker.ts), an ES module file of its own. It uses only
  // pure qledger-v1 functions from the RDK, whose one-file bundle would otherwise drag in cosmjs (about
  // 1.4 MB). Treating modules as side-effect-free cuts it to about 73 kB; `smoke:worker` (run in CI) proves
  // the built file still re-executes vigil-pay-1's recorded history correctly.
  worker: { format: "es", rolldownOptions: { treeshake: { moduleSideEffects: false } } },
  build: {
    target: "es2022",
    outDir: "dist",
    // Maps are written for local debugging but not referenced from the chunks (the deployed site leaves them out).
    sourcemap: "hidden",
    // vendor-chain (the RDK's SDK, cosmjs and cosmjs-types) is about 2.7 MB, but it is not on the first paint:
    // the views load it after the shell is up.
    chunkSizeWarningLimit: 3_000,
    rolldownOptions: {
      output: {
        // The shell (React, the app frame, the websocket client) loads first and small; the chain libraries
        // (the RDK with its SDK and cosmjs, viem, QoreSeal) are separate chunks the views load on demand.
        codeSplitting: {
          groups: [
            // Vite's tiny module-preload helper is used by the shell; keep it out of the vendor chunks.
            { name: "preload", test: /preload-helper/, priority: 40 },
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            // The landing page's scene and smooth scrolling: loaded after its first paint.
            { name: "vendor-three", test: /node_modules[\\/](three|lenis)[\\/]/, priority: 25 },
            { name: "vendor-viem", test: /node_modules[\\/](viem|abitype|ox|@adraffy|isows)[\\/]/, priority: 20 },
            // The QR code of a payslip share link: loaded only when a link is shown.
            { name: "vendor-qr", test: /node_modules[\\/]uqr[\\/]/, priority: 20 },
            { name: "vendor-chain", test: /node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
});
