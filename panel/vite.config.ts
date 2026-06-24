import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: proxy API + WebSocket to the in-process Fastify panel server.
// Prod: `vite build` emits to dist/, which Fastify serves directly.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
