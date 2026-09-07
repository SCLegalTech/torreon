import { dirname, resolve } from "node:path";
import { createHttpApp } from "./app.js";
import { createCodice } from "./codice.js";
import { Kingdom } from "./kingdom.js";
import { IdentityStore } from "./identity-store.js";
import { systemClock } from "./clock.js";
import { identityEnabled } from "./auth.js";
import { chosenStoreKind, createRealmStore } from "./realm-store-factory.js";

// Las credenciales del Códice viven en .env, no en el código ni en el repo.
for (const candidate of [".env", "../../.env"]) {
  try {
    process.loadEnvFile(resolve(candidate));
    break;
  } catch {
    // Sin .env el servidor arranca igual con el Códice heurístico.
  }
}

// `TORREON_PORT` manda sobre `PORT`. Algunos entornos de desarrollo exportan
// `PORT` para la interfaz, y entonces el Núcleo intentaba escuchar en el puerto
// de Vite: la app quedaba viva pero sin reino al que preguntar.
const port = Number(process.env.TORREON_PORT ?? process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const statePath = resolve(process.env.TORREON_STATE_PATH ?? "./data/torreon-state.json");

// Dónde vive el reino. `json` por defecto; `sqlite` es la persistencia real
// (ADR-0003) y se activa a propósito, nunca por sorpresa.
const storeKind = chosenStoreKind();
const store = createRealmStore(statePath, storeKind);
await store.init();
const instance = process.env.TORREON_INSTANCE?.trim() || `torreon-${host === '0.0.0.0' ? 'nube' : 'local'}`;

// EL REINO ES DE ALGUIEN, Y ALGUIEN PREGUNTA (artículos 10 y 11).
//
// El Kingdom reparte un servicio por jugador sobre el mismo almacén, el mismo
// reloj y el MISMO bus —si cada uno tuviera el suyo, una suscripción abierta se
// perdería los avisos—. Con `TORREON_IDENTITY=on` cada petición toca el reino
// de quien la firma; apagada, todo el mundo es el jugador de siempre.
const kingdom = new Kingdom(store, createCodice(), dirname(statePath), instance, systemClock, IdentityStore.beside(statePath, systemClock));
const app = createHttpApp(kingdom.realmOf(), kingdom);

app.listen(port, host, () => {
  process.stdout.write(`Torreón listo en http://${host}:${port}\nMCP: http://${host}:${port}/mcp\nContrato: http://${host}:${port}/v1\nReino: ${storeKind}
Identidad: ${identityEnabled() ? "on" : "off"}\n`);
});

