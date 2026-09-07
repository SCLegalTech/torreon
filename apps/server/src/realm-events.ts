import { randomUUID } from "node:crypto";
import type { GameEvent, NotificationType, RealmEvent, RealmState } from "./domain.js";
import { isoAt } from "./clock.js";
import { notifyFromEvent } from "./notifications.js";

/**
 * ESCRIBIR UN HECHO EN EL REINO.
 *
 * Extraído de `quest-service.ts`: todo el mundo registra hechos, así que no
 * puede vivir dentro del orquestador de quests. Aquí no hay reglas de juego,
 * sólo la manera —única— de dejar constancia.
 *
 * El recorte a 100/200 entradas que se ve aquí es una VIOLACIÓN CONOCIDA del
 * artículo 3 («anular no es borrar»), forzada por tener el log dentro del mismo
 * documento que el estado. Desaparece en la etapa 3 (ADR-0003), y vive en un
 * solo sitio precisamente para que entonces se borre de un solo sitio.
 */

const EVENT_LIMIT = 100;
const GAME_EVENT_LIMIT = 200;

/**
 * Un hecho SIEMPRE va atado a la entidad exacta que cambió.
 *
 * Sin `entityType` + `entityId` una notificación sólo puede adivinar —«el
 * último borrador», «la quest actual»— y termina abriendo otra cosa. Los
 * hechos de quest siguen rellenando `questId` por compatibilidad.
 */
export type RealmEventInput = Omit<RealmEvent, "id" | "createdAt" | "entityType" | "entityId"> &
  Partial<Pick<RealmEvent, "entityType" | "entityId">>;

export function addEvent(state: RealmState, event: RealmEventInput, nowMs: number): void {
  const entityType = event.entityType ?? "quest";
  const entityId = event.entityId ?? event.questId ?? "";
  const record: RealmEvent = { id: randomUUID(), createdAt: isoAt(nowMs), ...event, entityType, entityId };
  state.events.unshift(record);
  state.events = state.events.slice(0, EVENT_LIMIT);
  // DOMAIN EVENT -> NOTIFICATION RECORD: sólo los hechos que piden acción humana.
  // El resto (tick de reloj, presión, poll) nunca llega al Centro.
  notifyFromEvent(state, record, nowMs);
}

/** Un hecho de combate: lo que el renderer anima. Nunca decide nada por sí solo. */
export function pushGameEvent(state: RealmState, event: Omit<GameEvent, "id">): string {
  const id = randomUUID();
  state.gameEvents.unshift({ id, ...event });
  state.gameEvents = state.gameEvents.slice(0, GAME_EVENT_LIMIT);
  return id;
}

/** Marca leídas las notificaciones de una entidad de un tipo dado. */
export function markEntityNotificationsRead(
  state: RealmState,
  entityId: string,
  type: NotificationType,
  nowMs: number,
): void {
  const timestamp = isoAt(nowMs);
  for (const record of state.notifications ?? []) {
    if (record.entityId === entityId && record.type === type && !record.readAt) record.readAt = timestamp;
  }
}
