import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser journeys run a second copy of the app on other ports, against its own database
const port = Number(process.env.WEB_PORT ?? 5173);
const api = process.env.API_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port,
    strictPort: true,
    // Same origin from the browser's point of view: cookies and the Origin header pass through unchanged
    proxy: {
      "/api": { target: api, changeOrigin: false },
      // QuickBooks sign-in: a plain link that the API redirects to Intuit, and Intuit's return address.
      // Anchored with the slash, so the /connections page itself stays with the app.
      "^/connect/": { target: api, changeOrigin: false },
    },
  },
  preview: { port: 5173, strictPort: true },
  build: { sourcemap: false },
});
