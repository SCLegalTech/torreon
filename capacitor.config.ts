import type { CapacitorConfig } from "@capacitor/cli";

/**
 * LA APK ES UNA CÁSCARA, NO EL JUEGO.
 *
 * Antes la interfaz viajaba DENTRO del APK: cada arreglo de una pantalla —un
 * botón que no se leía, un panel montado encima de otro— exigía recompilar,
 * conectar un teléfono por cable e instalar. Y para los amigos, exigía además
 * hacerles llegar el archivo.
 *
 * Ahora la app carga la interfaz del mismo reino que ya le sirve los datos. Un
 * despliegue a Fly actualiza a todo el mundo a la vez, sin cable y sin
 * reinstalar. Sólo un cambio NATIVO —un plugin, un permiso, el icono— vuelve a
 * pedir un APK nuevo.
 *
 * Esto no rompe ninguna regla: el juego ya se negaba a jugarse sin Núcleo
 * (artículo 15), así que depender del reino para pintar no le quita nada.
 *
 * Quien levante su propio servidor lo apunta al suyo:
 *
 *   TORREON_APP_URL=https://mi-torreon.fly.dev npm run android:apk
 */
const reino = process.env.TORREON_APP_URL?.trim() || "https://torreon.fly.dev";

const config: CapacitorConfig = {
  appId: "com.solvecoagula.torreon",
  appName: "Torreon",
  webDir: "apps/web/dist",
  server: {
    url: reino,
    // Sin texto plano: el reino viaja por HTTPS o no viaja.
    cleartext: false,
    androidScheme: "https",
  },
  android: {
    backgroundColor: "#080806",
  },
};

export default config;
