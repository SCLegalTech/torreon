import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { systemClock } from "./clock.js";
import { DEFAULT_PLAYER_ID, isPlayerId, type PlayerId } from "./players.js";
import { sqlitePathFor } from "./realm-store-factory.js";
import { SqliteRealmStore, sqliteAvailable } from "./sqlite-store.js";
import { JsonRealmStore } from "./store.js";

/**
 * EL TRASLADO DEL REINO — de documento a base de datos (ADR-0003).
 *
 * Lee cada reino del almacén JSON y lo escribe en SQLite, con su expediente.
 * NO borra nada: el documento se queda donde está, así que volver atrás es
 * cambiar una variable de entorno. Es idempotente: correrlo dos veces deja el
 * mismo resultado.
 *
 *   npm run realm:sqlite            # usa TORREON_STATE_PATH o ./data/torreon-state.json
 *
 * ANTES DE CORRERLO EN LA NUBE: copia del volumen. Un reino es la vida real de
 * alguien, no un caché.
 */
export async function migrateRealmsToSqlite(statePath: string): Promise<{ playerId: PlayerId; quests: number; events: number }[]> {
  if (!sqliteAvailable()) {
    throw new Error("El traslado necesita Node 22.5 o superior (`node:sqlite`).");
  }
  const json = new JsonRealmStore(statePath, systemClock);
  const sqlite = new SqliteRealmStore(sqlitePathFor(statePath), systemClock);
  const resumen: { playerId: PlayerId; quests: number; events: number }[] = [];

  for (const playerId of await playersIn(statePath)) {
    const state = await json.read(playerId);
    await sqlite.mutate((draft) => {
      for (const clave of Object.keys(draft)) delete (draft as unknown as Record<string, unknown>)[clave];
      Object.assign(draft, state);
      return draft;
    }, playerId);
    resumen.push({
      playerId,
      quests: state.quests.length,
      events: (await sqlite.history(playerId, { limit: 5000 })).length,
    });
  }

  sqlite.close();
  return resumen;
}

/** Quiénes tienen reino en el almacén de documentos. */
async function playersIn(statePath: string): Promise<PlayerId[]> {
  const players: PlayerId[] = [];
  if (existsSync(statePath)) players.push(DEFAULT_PLAYER_ID);
  const realms = join(dirname(statePath), "realms");
  if (existsSync(realms)) {
    for (const file of await readdir(realms)) {
      const playerId = file.replace(/\.json$/i, "");
      if (file.endsWith(".json") && isPlayerId(playerId)) players.push(playerId);
    }
  }
  return players;
}

// Ejecutado directamente: `node dist/realm-to-sqlite.js`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  const statePath = resolve(process.env.TORREON_STATE_PATH ?? "./data/torreon-state.json");
  const resumen = await migrateRealmsToSqlite(statePath);
  process.stdout.write(`Reinos trasladados a ${sqlitePathFor(statePath)}\n`);
  for (const fila of resumen) {
    process.stdout.write(`  ${fila.playerId}: ${fila.quests} quests, ${fila.events} hechos archivados\n`);
  }
  process.stdout.write("El documento JSON sigue intacto. Para usar el reino nuevo: TORREON_STORE=sqlite\n");
}
