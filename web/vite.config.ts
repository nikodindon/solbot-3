import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Le front est compilé dans `web/dist`, que le serveur Node sert tel quel.
 *
 * En développement, Vite proxifie l'API vers le bot : le front tourne sur
 * 5173, les données viennent du dashboard sur 4200.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Un seul bundle : le dashboard est un outil local, pas un site public.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4200",
        changeOrigin: true,
      },
    },
  },
});
