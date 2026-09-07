import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
      // El contrato nuevo, incluida la suscripción: sin esto `/v1/stream` caía
      // en el index.html de Vite y el cliente reconectaba en bucle.
      "/v1": "http://127.0.0.1:3000",
    },
  },
});

