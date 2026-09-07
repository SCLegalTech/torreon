import { systemClock, type Clock } from "./clock.js";
import type { CodicePlanner } from "./codice.js";
import { HeuristicCodice } from "./codice.js";
import { IdentityStore } from "./identity-store.js";
import { DEFAULT_PLAYER_ID, type PlayerId } from "./players.js";
import { QuestService } from "./quest-service.js";
import { RealmBus } from "./realm-bus.js";
import type { RealmStore } from "./realm-store.js";

/**
 * EL REINO ENTERO, COMPUESTO EN UN SITIO.
 *
 * Antes había UN `QuestService` para todo el proceso, porque había un solo
 * reino. Con el jugador como raíz (artículo 10) hace falta uno por jugador, y
 * hace falta que compartan lo que debe ser compartido:
 *
 *   - el ALMACÉN, para que dos jugadores no se pisen ni se vean;
 *   - el BUS, para que una suscripción abierta reciba los avisos del reino que
 *     escucha —si cada servicio tuviera su bus, el aviso se perdería—;
 *   - el RELOJ, para que el tiempo sea uno solo.
 *
 * Los servicios se memorizan por jugador: crear uno es barato, pero el bus
 * compartido exige que sea SIEMPRE el mismo objeto para el mismo reino.
 */
export class Kingdom {
  private readonly realms = new Map<PlayerId, QuestService>();
  readonly bus = new RealmBus();
  readonly identity: IdentityStore;

  constructor(
    private readonly store: RealmStore,
    private readonly codice: CodicePlanner = new HeuristicCodice(),
    private readonly dataDir = "./data",
    private readonly instance = process.env.TORREON_INSTANCE?.trim() || "torreon-local",
    private readonly clock: Clock = systemClock,
    identity?: IdentityStore,
  ) {
    this.identity = identity ?? IdentityStore.beside(`${dataDir}/torreon-state.json`, clock);
  }

  /** El servicio que sirve al reino de este jugador. Nunca al de otro. */
  realmOf(playerId: PlayerId = DEFAULT_PLAYER_ID): QuestService {
    const existing = this.realms.get(playerId);
    if (existing) return existing;
    const service = new QuestService(this.store, this.codice, this.dataDir, this.instance, this.clock, playerId, this.bus);
    this.realms.set(playerId, service);
    return service;
  }

  get realmClock(): Clock {
    return this.clock;
  }
}
