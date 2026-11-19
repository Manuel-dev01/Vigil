import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the built site works from any host and sub-path.
  base: "./",
  plugins: [react()],
  assetsInclude: ["**/*.binpb"],
  build: { target: "es2022", outDir: "dist", sourcemap: true },
});
