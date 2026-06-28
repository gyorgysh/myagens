import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Dev: proxy API + WebSocket to the in-process Fastify panel server.
// Prod: `vite build` emits to dist/, which Fastify serves directly.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // injectManifest: we ship our own service worker (src/sw.ts) so it can
      // handle Web Push (push / notificationclick) on top of the workbox-based
      // offline caching. The plugin injects the precache manifest into it.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
      // Don't enable the SW in `vite dev`. It would cache the dev server and
      // fight the /api + /ws proxy, so it only ships in the production build.
      devOptions: { enabled: false },
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "fonts/*.woff2"],
      manifest: {
        name: "MyHQ",
        short_name: "HQ",
        description: "Personal AI command center for managing your Atlas fleet.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#5d62d1",
        background_color: "#0a0a0b",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      // Runtime caching + navigation fallback now live inside src/sw.ts (the
      // injectManifest source), since `workbox.runtimeCaching` only applies in
      // generateSW mode.
    }),
  ],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
