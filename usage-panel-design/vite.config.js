import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望 dev server 在 127.0.0.1:1420
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/portable/**"],
    },
    proxy: {
      // Anonymous public scores; credentials are never included.
      "/radar-bench-score": {
        target: "https://api.codexradar.com",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/radar-bench-score/, "/api/v1/radar-bench-score"),
      },
    },
  },
});
