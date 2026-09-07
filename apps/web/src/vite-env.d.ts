/// <reference types="vite/client" />

/**
 * Variables horneadas en la interfaz al compilar. Sólo `VITE_*` llegan al
 * paquete, y lo que se hornea es PÚBLICO: cualquiera puede extraerlo del APK.
 * Aquí sólo cabe un tapón, nunca una credencial de verdad (ADR-0007).
 */
interface ImportMetaEnv {
  readonly VITE_TORREON_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
