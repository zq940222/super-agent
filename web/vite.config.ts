import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file build (ADR-0003 §6): inline JS/CSS into one index.html so the whole
// client arrives in the one `?token=`-authorized document the server serves.
// In dev, Vite serves the app and proxies the API to the Bun server (port 8787).
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/prompt": "http://localhost:8787",
      "/approve": "http://localhost:8787",
    },
  },
});
