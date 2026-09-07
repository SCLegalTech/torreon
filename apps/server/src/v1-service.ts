import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { battleQuestOf, battleFor, engagedQuest, QuestService } from "./quest-service.js";
import { notFound } from "./errors.js";
import type { NotificationQuery } from "./notifications.js";
import {
  barracksView,
  battleView,
  cursorOf,
  notificationsView,
  realmMapView,
  realmSummaryView,
  treasuryView,
  type BattleView,
  type RealmSummaryView,
} from "./v1-views.js";
import type { BarracksView, RealmHierarchy, QuestDetail } from "./domain.js";

/**
 * EL SOBRE DEL CONTRATO `/v1` (artículo 13).
 *
 * Todas las respuestas viajan igual. `schemaVersion` dice qué forma tiene lo de
 * dentro; `serverTime` recuerda que **el reloj autoritativo es el del
 * servidor**, no el del teléfono; `cursor` ata esta foto a un punto exacto del
 * expediente, para que el cliente pueda suscribirse desde ahí sin perder nada.
 *
 * Dentro de una versión mayor sólo se AÑADE. Cuando la APK esté publicada,
 * romper el contrato es romper teléfonos que no controlamos.
 */
export const SCHEMA_VERSION = 1;

export interface Envelope<T> {
  schemaVersion: number;
  serverTime: string;
  cursor: string;
  data: T;
}

/**
 * La capa de lectura de `/v1`.
 *
 * Cada pantalla pide LO SUYO. Nada de esto entrega el estado persistido: eso
 * era `GET /api/state`, y era 345 MB por hora y cliente.
 */
export class RealmViews {
  constructor(
    private readonly service: QuestService,
    private readonly clock: Clock = systemClock,
  ) {}

  private wrap<T>(data: T, cursor: string): Envelope<T> {
    return { schemaVersion: SCHEMA_VERSION, serverTime: this.clock.iso(), cursor, data };
  }

  async summary(): Promise<Envelope<RealmSummaryView>> {
    const state = await this.service.tick();
    const engaged = engagedQuest(state);
    const focus = battleQuestOf(state);
    const battle = battleFor(focus, this.clock.now(), state.gameEvents);
    return this.wrap(
      realmSummaryView(state, this.clock.now(), {
        instance: this.service.instanceName,
        currentQuest: null,
        engagedQuest: engaged,
        battleQuestId: focus?.id ?? null,
        battle,
      }),
      cursorOf(state),
    );
  }

  async battle(questId: string): Promise<Envelope<BattleView>> {
    const state = await this.service.tick();
    const quest = state.quests.find((candidate) => candidate.id === questId);
    if (!quest) throw notFound(`Quest no encontrada: ${questId}`);
    const view = battleView(state, questId, battleFor(quest, this.clock.now(), state.gameEvents), this.clock.now());
    if (!view) throw notFound(`Quest no encontrada: ${questId}`);
    return this.wrap(view, cursorOf(state));
  }

  async map(): Promise<Envelope<RealmHierarchy>> {
    const state = await this.service.tick();
    return this.wrap(realmMapView(state, engagedQuest(state)?.id ?? null), cursorOf(state));
  }

  async quest(questId: string): Promise<Envelope<QuestDetail>> {
    const state = await this.service.tick();
    return this.wrap(await this.service.questDetail(questId), cursorOf(state));
  }

  async barracks(): Promise<Envelope<BarracksView>> {
    const state = await this.service.tick();
    return this.wrap(barracksView(state), cursorOf(state));
  }

  async notifications(query: NotificationQuery = {}): Promise<Envelope<ReturnType<typeof notificationsView>>> {
    const state = await this.service.tick();
    return this.wrap(notificationsView(state, this.clock.now(), query), cursorOf(state));
  }

  async treasury(): Promise<Envelope<ReturnType<typeof treasuryView>>> {
    const state = await this.service.tick();
    return this.wrap(treasuryView(state, this.clock.now()), cursorOf(state));
  }

  /** El cursor de ahora mismo, para abrir una suscripción sin pedir una vista. */
  async cursor(): Promise<string> {
    return cursorOf(await this.service.tick());
  }
}
