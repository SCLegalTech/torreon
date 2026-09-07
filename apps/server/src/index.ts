import { dirname, resolve } from "node:path";
import { createHttpApp } from "./app.js";
import { createCodice } from "./codice.js";
import { QuestService } from "./quest-service.js";
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

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const statePath = resolve(process.env.TORREON_STATE_PATH ?? "./data/torreon-state.json");

// Dónde vive el reino. `json` por defecto; `sqlite` es la persistencia real
// (ADR-0003) y se activa a propósito, nunca por sorpresa.
const storeKind = chosenStoreKind();
const store = createRealmStore(statePath, storeKind);
await store.init();
const service = new QuestService(store, createCodice(), dirname(statePath), process.env.TORREON_INSTANCE?.trim() || `torreon-${host === '0.0.0.0' ? 'nube' : 'local'}`);
const app = createHttpApp(service);

app.listen(port, host, () => {
  process.stdout.write(`Torreón listo en http://${host}:${port}\nMCP: http://${host}:${port}/mcp\n`);
});

