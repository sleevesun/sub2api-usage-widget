import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望 dev server 在 127.0.0.1:1420
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: {
      // dev 环境代理 radar API，规避 CORS
      "/radar-api": {
        target: "https://api.codexradar.com",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/radar-api/, "/api/v1/radar-insights"),
      },
    },
  },
});
