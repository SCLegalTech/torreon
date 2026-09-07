import type { RealmState } from "./domain.js";
import type { PlayerId } from "./players.js";

/**
 * EL PUERTO DE LA PERSISTENCIA (artículo 6, ADR-0003).
 *
 * El Núcleo no conoce el almacén: recibe estado. Este puerto es lo que permite
 * cambiar JSON por SQLite —y mañana por Postgres— sin tocar una sola regla del
 * juego. Existía ya como disciplina; ahora existe como tipo.
 */
export interface RealmStore {
  /** Deja listo el reino de un jugador. Idempotente. */
  init(playerId?: PlayerId): Promise<void>;
  /** El estado actual del reino de un jugador, ya migrado y conciliado. */
  read(playerId?: PlayerId): Promise<RealmState>;
  /**
   * Una operación = una transacción.
   *
   * La mutación recibe el estado, lo cambia, y el almacén lo persiste entero y
   * de una pieza. Nadie más escribe ese reino mientras tanto.
   */
  mutate<T>(
    mutation: (state: RealmState) => T | Promise<T>,
    playerId?: PlayerId,
  ): Promise<{ result: T; state: RealmState }>;
  /** Devuelve el reino a su estado inicial. No borra el log de hechos. */
  reset(playerId?: PlayerId): Promise<RealmState>;
  /** El expediente: todo lo que pasó, sin techo. `null` si el almacén no lo guarda. */
  history?(playerId: PlayerId, query?: HistoryQuery): Promise<HistoryEntry[]>;
  /**
   * EL DERECHO AL OLVIDO.
   *
   * Borra el reino de un jugador y su historia. No contradice el artículo 3
   * —que protege la historia dentro de una partida—: esto va sobre la partida
   * entera, y un expediente al que no se puede renunciar no es un expediente.
   */
  forget?(playerId: PlayerId): Promise<boolean>;
}

export interface HistoryQuery {
  /** Devuelve sólo lo posterior a este `seq`. Para reanudar una suscripción. */
  since?: number;
  limit?: number;
}

/**
 * UN HECHO, TAL COMO OCURRIÓ.
 *
 * El log es append-only y SIN TECHO (artículo 3). El recorte a 100/200 que
 * sufre `RealmState` es una limitación del documento JSON, no una política: un
 * almacén que sepa guardar historia debe guardarla entera.
 */
export interface HistoryEntry {
  seq: number;
  eventId: string;
  playerId: PlayerId;
  /** `realm` son hechos del reino; `game` son hechos de combate. */
  source: "realm" | "game";
  type: string;
  createdAt: string;
  payload: unknown;
}
