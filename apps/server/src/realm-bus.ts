import type { GameEvent, RealmEvent, RealmState } from "./domain.js";
import type { PlayerId } from "./players.js";

/**
 * EL AVISO DE QUE LA VERDAD CAMBIÓ.
 *
 * El cliente sondeaba el mundo entero cada 1,5 s porque no había forma de
 * enterarse de otra manera. Esto es esa otra manera: cuando una mutación
 * termina, el reino avisa; quien esté escuchando refresca la vista que le toca.
 *
 * Lo que viaja NO es la verdad, es el aviso de que la verdad cambió (contrato
 * de cliente, § 4). Si la animación y la vista discrepan, gana la vista.
 *
 * Pub/sub en memoria, dentro de un proceso. Con varias máquinas haría falta un
 * canal compartido; hasta E3 hay una sola máquina por diseño, y para entonces
 * el expediente en SQLite ya da reanudación por cursor.
 */
export interface RealmTick {
  playerId: PlayerId;
  cursor: string;
  /** Hechos del reino, del más reciente al más antiguo, como los guarda el estado. */
  events: RealmEvent[];
  /** Hechos de combate: lo que el renderer anima. */
  gameEvents: GameEvent[];
}

type Listener = (tick: RealmTick) => void;

export class RealmBus {
  private readonly listeners = new Map<PlayerId, Set<Listener>>();

  subscribe(playerId: PlayerId, listener: Listener): () => void {
    const set = this.listeners.get(playerId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(playerId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(playerId);
    };
  }

  publish(playerId: PlayerId, state: RealmState): void {
    const set = this.listeners.get(playerId);
    if (!set || set.size === 0) return;
    const tick: RealmTick = {
      playerId,
      cursor: state.events[0]?.id ?? "",
      events: state.events ?? [],
      gameEvents: state.gameEvents ?? [],
    };
    // Un oyente que revienta no puede tumbar a los demás ni a la mutación.
    for (const listener of [...set]) {
      try {
        listener(tick);
      } catch {
        // El registro es la verdad; la entrega es sólo entrega.
      }
    }
  }

  /** Cuántos escuchan ahora mismo. Para diagnóstico, no para decidir nada. */
  listenerCount(playerId: PlayerId): number {
    return this.listeners.get(playerId)?.size ?? 0;
  }
}

/**
 * Los hechos posteriores a un cursor, del más antiguo al más reciente.
 *
 * Sin cursor, todo lo que hay. Si el cursor ya no está en la ventana que el
 * estado conserva, se devuelve la ventana entera: es mejor que el cliente
 * rehidrate de más a que pierda un hecho en silencio.
 */
export function eventsSince<T extends { id: string }>(events: T[], cursor: string | undefined): T[] {
  const ordered = [...events].reverse();
  if (!cursor) return ordered;
  const index = ordered.findIndex((event) => event.id === cursor);
  return index === -1 ? ordered : ordered.slice(index + 1);
}
