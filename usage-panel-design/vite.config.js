import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { codexRadarPreview } from "./scripts/codex-radar-preview.mjs";

// Tauri 期望 dev server 在 127.0.0.1:1420
export default defineConfig({
  plugins: [react(), codexRadarPreview()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/portable/**"],
    },
  },
});
