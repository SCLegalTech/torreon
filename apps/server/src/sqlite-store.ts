import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { isoAt, systemClock, type Clock } from "./clock.js";
import type { RealmState } from "./domain.js";
import { DEFAULT_PLAYER_ID, requirePlayerId, type PlayerId } from "./players.js";
import type { HistoryEntry, HistoryQuery, RealmStore } from "./realm-store.js";
import { createInitialState, migrateRealm } from "./store.js";

/**
 * EL REINO EN SQLITE (ADR-0003).
 *
 * El documento JSON era a la vez base de datos, log de auditoría y DTO. De ahí
 * salían tres averías distintas:
 *
 *   1. **La auditoría se borraba sola.** Como el log vivía dentro del documento
 *      que se reescribe entero, había que recortarlo (`slice(0, 200)`). Un
 *      producto cuya tesis es la evidencia comprobada destruía su evidencia a
 *      partir del evento 201. Aquí el log es una tabla append-only SIN TECHO.
 *   2. **La concurrencia era una cola en memoria.** Dos procesos se pisaban sin
 *      error. Aquí una mutación es una transacción de verdad, y SQLite en modo
 *      WAL serializa a los escritores aunque sean procesos distintos.
 *   3. **Coste O(estado completo)** en cada lectura y escritura. El estado sigue
 *      guardándose como documento —normalizar el dominio entero sería otra
 *      obra— pero deja de crecer con la historia, que es lo que lo engordaba.
 *
 * Requiere Node 22.5+ por `node:sqlite`. El adaptador JSON sigue existiendo y
 * es el que usan las máquinas con Node 20.
 */

type SqliteValue = string | number | null;

interface Statement {
  run(...params: SqliteValue[]): unknown;
  get(...params: SqliteValue[]): Record<string, SqliteValue> | undefined;
  all(...params: SqliteValue[]): Record<string, SqliteValue>[];
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const requireNode = createRequire(import.meta.url);

/** `node:sqlite` es de Node 22.5+. Aquí se dice claro en vez de romper raro. */
export function sqliteAvailable(): boolean {
  try {
    requireNode("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function openDatabase(path: string): Database {
  if (!sqliteAvailable()) {
    throw new Error("El reino en SQLite necesita Node 22.5 o superior (`node:sqlite`). Con Node 20 usa el almacén JSON.");
  }
  const { DatabaseSync } = requireNode("node:sqlite") as { DatabaseSync: new (path: string) => Database };
  return new DatabaseSync(path);
}

/**
 * MIGRACIONES VERSIONADAS (artículo 20).
 *
 * Ejecutadas una vez al abrir, idempotentes y registradas. Nada de rellenos
 * dispersos ejecutándose en cada lectura.
 */
const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "reino-y-expediente",
    sql: `
      CREATE TABLE IF NOT EXISTS realms (
        player_id  TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- CONCURRENCIA OPTIMISTA. Quien escribe declara sobre qué revisión
        -- decidió; si otro se le adelantó, su escritura no entra y se rehace
        -- sobre la verdad nueva. Nunca se pierde una en silencio.
        revision   INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS realm_events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   TEXT NOT NULL,
        player_id  TEXT NOT NULL,
        source     TEXT NOT NULL,
        type       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload    TEXT NOT NULL,
        UNIQUE (player_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS realm_events_por_jugador ON realm_events (player_id, seq);
    `,
  },
];

export class SqliteRealmStore implements RealmStore {
  private readonly db: Database;
  /** Evita que dos mutaciones del MISMO reino compitan dentro de un proceso. */
  private readonly queues = new Map<PlayerId, Promise<unknown>>();

  constructor(
    databasePath: string,
    private readonly clock: Clock = systemClock,
  ) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.db = openDatabase(databasePath);
    // WAL: los lectores no bloquean al escritor y el escritor no bloquea a los
    // lectores. `FULL` porque perder una evidencia validada no es aceptable.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = new Set(this.db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, this.clock.iso());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  async init(playerId: PlayerId = DEFAULT_PLAYER_ID): Promise<void> {
    requirePlayerId(playerId);
    const existing = this.db.prepare("SELECT player_id FROM realms WHERE player_id = ?").get(playerId);
    if (existing) return;
    this.persist(createInitialState(this.clock.now(), playerId), playerId);
  }

  async read(playerId: PlayerId = DEFAULT_PLAYER_ID): Promise<RealmState> {
    return (await this.load(playerId)).state;
  }

  /** El reino y la revisión sobre la que se leyó. La revisión es el testigo. */
  private async load(playerId: PlayerId): Promise<{ state: RealmState; revision: number }> {
    requirePlayerId(playerId);
    const row = this.db.prepare("SELECT state, revision FROM realms WHERE player_id = ?").get(playerId);
    if (!row) {
      await this.init(playerId);
      return this.load(playerId);
    }
    const state = JSON.parse(String(row.state)) as RealmState;
    state.playerId ??= playerId;
    return { state: migrateRealm(state, this.clock.now()), revision: Number(row.revision ?? 0) };
  }

  /**
   * UNA OPERACIÓN, UNA TRANSACCIÓN.
   *
   * Leer, decidir y escribir ocurren dentro de la misma transacción: se acabó
   * la lectura-modificación-escritura partida entre llamadas.
   */
  async mutate<T>(
    mutation: (state: RealmState) => T | Promise<T>,
    playerId: PlayerId = DEFAULT_PLAYER_ID,
  ): Promise<{ result: T; state: RealmState }> {
    requirePlayerId(playerId);
    const operation = (this.queues.get(playerId) ?? Promise.resolve()).then(() => this.attempt(mutation, playerId));
    this.queues.set(playerId, operation.then(() => undefined, () => undefined));
    return operation;
  }

  /**
   * DECIDIR SOBRE LA VERDAD, NO SOBRE UNA FOTO VIEJA.
   *
   * Se lee con revisión, se decide, y se escribe SÓLO si nadie se adelantó. Si
   * alguien lo hizo, la decisión se rehace sobre el estado nuevo en vez de
   * pisarla: una escritura perdida en silencio es el peor final posible para
   * una evidencia validada.
   */
  private async attempt<T>(
    mutation: (state: RealmState) => T | Promise<T>,
    playerId: PlayerId,
    intento = 1,
  ): Promise<{ result: T; state: RealmState }> {
    const { state, revision } = await this.load(playerId);
    const result = await mutation(state);
    state.updatedAt = this.clock.iso();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const written = this.persist(state, playerId, revision);
      if (!written) {
        this.db.exec("ROLLBACK");
        if (intento >= 5) throw new Error("El reino cambió bajo esta operación demasiadas veces seguidas.");
        return this.attempt(mutation, playerId, intento + 1);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { result, state };
  }

  /** Devolver el reino a cero NO borra el expediente: eso sería reescribir la historia. */
  async reset(playerId: PlayerId = DEFAULT_PLAYER_ID): Promise<RealmState> {
    requirePlayerId(playerId);
    const { result } = await this.mutate((state) => {
      const fresco = createInitialState(this.clock.now(), playerId);
      // Se vacía el reino EN SITIO para que la escritura siga siendo la de esta
      // revisión: reiniciar no puede saltarse la carrera que evita perder nada.
      for (const clave of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[clave];
      Object.assign(state, fresco);
      return state;
    }, playerId);
    return result;
  }

  async history(playerId: PlayerId, query: HistoryQuery = {}): Promise<HistoryEntry[]> {
    requirePlayerId(playerId);
    const rows = this.db
      .prepare("SELECT seq, event_id, player_id, source, type, created_at, payload FROM realm_events WHERE player_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(playerId, query.since ?? 0, Math.min(Math.max(query.limit ?? 500, 1), 5000));
    return rows.map((row) => ({
      seq: Number(row.seq),
      eventId: String(row.event_id),
      playerId: String(row.player_id),
      source: String(row.source) === "game" ? "game" : "realm",
      type: String(row.type),
      createdAt: String(row.created_at),
      payload: JSON.parse(String(row.payload)),
    }));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Guarda el reino y ARCHIVA todo hecho que todavía no estuviera archivado.
   *
   * `INSERT OR IGNORE` por `event_id` hace el archivado idempotente: el
   * documento sólo conserva los últimos 100/200 hechos, pero el expediente los
   * conserva TODOS. Ese es el artículo 3 cumpliéndose de verdad.
   */
  private persist(state: RealmState, playerId: PlayerId, revision?: number): boolean {
    const updatedAt = state.updatedAt ?? isoAt(this.clock.now());
    if (revision === undefined) {
      this.db
        .prepare("INSERT INTO realms (player_id, state, updated_at, revision) VALUES (?, ?, ?, 0) ON CONFLICT(player_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, revision = realms.revision + 1")
        .run(playerId, JSON.stringify(state), updatedAt);
    } else {
      this.db
        .prepare("UPDATE realms SET state = ?, updated_at = ?, revision = revision + 1 WHERE player_id = ? AND revision = ?")
        .run(JSON.stringify(state), updatedAt, playerId, revision);
      const actual = this.db.prepare("SELECT revision FROM realms WHERE player_id = ?").get(playerId);
      if (Number(actual?.revision ?? -1) !== revision + 1) return false;
    }

    const archive = this.db.prepare(
      "INSERT OR IGNORE INTO realm_events (event_id, player_id, source, type, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const event of state.events ?? []) {
      archive.run(event.id, playerId, "realm", event.type, event.createdAt, JSON.stringify(event));
    }
    for (const event of state.gameEvents ?? []) {
      archive.run(event.id, playerId, "game", event.type, event.createdAt, JSON.stringify(event));
    }
    return true;
  }
}
