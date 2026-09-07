import { resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import type { RealmStore } from "./realm-store.js";
import { SqliteRealmStore, sqliteAvailable } from "./sqlite-store.js";
import { JsonRealmStore } from "./store.js";

/**
 * QUÉ ALMACÉN MONTA EL REINO.
 *
 * `TORREON_STORE=sqlite` usa la persistencia real (ADR-0003): transacciones,
 * concurrencia optimista y un expediente append-only SIN TECHO. `json` —el
 * valor por defecto— usa el documento de siempre, que sigue siendo el camino
 * soportado en Node 20.
 *
 * El cambio NO es automático a propósito. Cambiar dónde vive el reino de un
 * jugador que ya está jugando exige copia previa y una decisión de persona; el
 * código está listo para las dos, y `npm run realm:sqlite` hace el traslado.
 */
export type StoreKind = "json" | "sqlite";

export function chosenStoreKind(raw = process.env.TORREON_STORE): StoreKind {
  return raw?.trim().toLowerCase() === "sqlite" ? "sqlite" : "json";
}

export function sqlitePathFor(statePath: string): string {
  return resolve(statePath.replace(/\.json$/i, "") || statePath).concat(".db");
}

export function createRealmStore(statePath: string, kind: StoreKind = chosenStoreKind(), clock: Clock = systemClock): RealmStore {
  if (kind !== "sqlite") return new JsonRealmStore(statePath, clock);
  if (!sqliteAvailable()) {
    throw new Error(
      "TORREON_STORE=sqlite necesita Node 22.5 o superior (`node:sqlite`). Con Node 20, el reino vive en el documento JSON.",
    );
  }
  return new SqliteRealmStore(sqlitePathFor(statePath), clock);
}
