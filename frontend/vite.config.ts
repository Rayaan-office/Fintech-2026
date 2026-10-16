import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Same origin from the browser's point of view: cookies and the Origin header pass through unchanged
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: false },
      // QuickBooks sign-in: a plain link that the API redirects to Intuit, and Intuit's return address.
      // Anchored with the slash, so the /connections page itself stays with the app.
      "^/connect/": { target: "http://localhost:8000", changeOrigin: false },
    },
  },
  preview: { port: 5173, strictPort: true },
  build: { sourcemap: false },
});
