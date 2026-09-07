import { createHash } from "node:crypto";
import type {
  NotificationEntityType,
  NotificationPriority,
  NotificationRecord,
  NotificationScreen,
  NotificationType,
  NotificationView,
  PushStatus,
  RealmEvent,
  RealmState,
} from "./domain.js";
import { obligationPeriodStatus, periodOf } from "./finance.js";

/**
 * CENTRO DE NOTIFICACIONES.
 *
 * A PUSH IS A KNOCK ON THE GATE. THE NOTIFICATION CENTER IS THE RECORD.
 * A KNOCK MAY BE MISSED. THE PACT MUST NOT DISAPPEAR.
 *
 * Aquí se decide qué HECHO merece un registro persistente para acción humana.
 * No todos los `events[]`: un `horde_pressure` o un tick de HP jamás entran.
 * La deduplicación es por `type:entityType:entityId:version`, así que un
 * polling, un redeploy o un `resend` no crean un segundo registro.
 */

/** Una Quest en estos estados ya no pide nada: ni avisos, ni atención. */
const CLOSED_QUEST_STATUS = new Set(["completed", "abandoned"]);
import { isoAt } from "./clock.js";
import { deny, notFound } from "./errors.js";

export function notificationKey(
  type: NotificationType,
  entityType: NotificationEntityType,
  entityId: string,
  version: number,
): string {
  return `${type}:${entityType}:${entityId}:v${version}`;
}

/**
 * Id ESTABLE derivado del `key` (UUID v5 sobre sha1).
 *
 * El backfill regenera sus registros en cada lectura hasta que una mutación los
 * persiste; si el id fuera aleatorio, cambiaría entre polls y `resend` no
 * encontraría nada. Con un id derivado del key, el registro transitorio y el
 * persistido comparten identidad.
 */
export function stableNotificationId(key: string): string {
  const h = createHash("sha1").update(`torreon:notification:${key}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** El deep link apunta a una pantalla; el id lo resuelve exacto, nunca el título. */
export function screenFor(entityType: NotificationEntityType): NotificationScreen {
  switch (entityType) {
    case "campaign":
      return "campaign";
    case "act":
      return "act";
    case "obligation":
      return "treasury";
    default:
      return "quest";
  }
}

export interface NotificationSpec {
  type: NotificationType;
  title: string;
  body: string;
  entityType: NotificationEntityType;
  entityId: string;
  priority?: NotificationPriority;
  version?: number;
  screen?: NotificationScreen;
  backfilled?: boolean;
}

/**
 * Añade un registro si su `key` no existe todavía (ni siquiera archivado).
 * Devuelve el registro nuevo, o el existente si ya estaba.
 */
export function addNotification(state: RealmState, spec: NotificationSpec, nowMs: number): NotificationRecord {
  state.notifications ??= [];
  const version = spec.version ?? 1;
  const key = notificationKey(spec.type, spec.entityType, spec.entityId, version);
  const existing = state.notifications.find((record) => record.key === key);
  if (existing) return existing;

  const record: NotificationRecord = {
    // Id derivado del key: estable entre el registro transitorio del backfill y
    // el persistido, para que `resend` siempre encuentre el mismo.
    id: stableNotificationId(key),
    key,
    type: spec.type,
    title: spec.title,
    body: spec.body,
    entityType: spec.entityType,
    entityId: spec.entityId,
    priority: spec.priority ?? "normal",
    deepLink: { screen: spec.screen ?? screenFor(spec.entityType), entityId: spec.entityId },
    version,
    createdAt: isoAt(nowMs),
    readAt: null,
    archivedAt: null,
    push: { lastAttemptAt: null, lastStatus: "unknown", attempts: 0 },
    backfilled: spec.backfilled,
  };
  state.notifications.unshift(record);
  state.notifications = state.notifications.slice(0, 200);
  attemptPush(record, nowMs);
  return record;
}

/**
 * PUSH ES DELIVERY, NO STORAGE.
 *
 * No hay canal FCM en este MVP: el intento se registra y el estado queda
 * `unknown` porque nadie puede confirmar que el jugador lo vio. `resend` sólo
 * abre un intento nuevo; nunca crea un segundo registro ni un domain event.
 */
export function attemptPush(record: NotificationRecord, nowMs: number, status: PushStatus = "unknown"): NotificationRecord {
  record.push.lastAttemptAt = isoAt(nowMs);
  record.push.lastStatus = status;
  record.push.attempts += 1;
  return record;
}

/**
 * Mapa EVENT -> NOTIFICATION. Sólo hechos que piden acción humana.
 * `undefined` = ese tipo de evento no genera notificación.
 */
export function specFromEvent(state: RealmState, event: RealmEvent): NotificationSpec | undefined {
  const entityType = (event.entityType ?? "quest") as NotificationEntityType;
  const entityId = event.entityId || event.questId || "";
  if (!entityId) return undefined;
  const quest = state.quests.find((candidate) => candidate.id === entityId);
  const questVersion = quest?.version ?? 1;

  switch (event.type) {
    case "quest_created":
      return {
        type: "quest_created",
        title: "Un nuevo pacto aguarda tu sello",
        body: quest?.title ?? event.message,
        entityType: "quest",
        entityId,
        priority: "normal",
        version: 1,
      };
    case "campaign_created":
      return {
        type: "campaign_created",
        title: "Una nueva campaña espera tu sello",
        body: state.campaigns.find((candidate) => candidate.id === entityId)?.title ?? event.message,
        entityType: "campaign",
        entityId,
        priority: "normal",
        version: 1,
      };
    case "quest_amendment_proposed": {
      const isRecontract = /repactar|pacto temporal|tiempo de/i.test(event.message);
      return {
        type: isRecontract ? "battle_recontract_proposed" : "quest_amendment_proposed",
        title: isRecontract ? "Nuevo pacto temporal propuesto" : "El campo de batalla puede cambiar",
        body: event.message,
        entityType: "quest",
        entityId,
        priority: "high",
        version: questVersion,
        screen: "battle",
      };
    }
    case "quest_waiting_external":
      return {
        type: "quest_waiting_external",
        title: "Un frente quedó bloqueado por un tercero",
        body: quest?.title ? `«${quest.title}» espera una condición externa.` : event.message,
        entityType: "quest",
        entityId,
        priority: "high",
        version: questVersion,
      };
    case "quest_unblocked":
      return {
        type: "quest_unblocked",
        title: "El frente vuelve a abrirse",
        body: quest?.title ? `«${quest.title}» ya no espera a nadie.` : event.message,
        entityType: "quest",
        entityId,
        priority: "high",
        version: questVersion,
        screen: "battle",
      };
    case "battle_lost":
      return {
        type: "battle_lost",
        title: "El plazo venció: puedes replanificar",
        body: quest?.title ? `El frente de «${quest.title}» sigue abierto. Nada de lo validado se pierde.` : event.message,
        entityType: "quest",
        entityId,
        priority: "high",
        version: quest?.battle?.attempt ?? 1,
        screen: "battle",
      };
    default:
      return undefined;
  }
}

export function notifyFromEvent(state: RealmState, event: RealmEvent, nowMs: number): void {
  const spec = specFromEvent(state, event);
  if (spec) addNotification(state, spec, nowMs);
}

/**
 * BACKFILL SEGURO.
 *
 * Sólo estado ACCIONABLE ahora mismo: borradores pendientes, frentes en espera
 * externa, replanes disponibles, enmiendas propuestas y obligaciones vencidas.
 * No convierte años de `events[]` en miles de notificaciones. Idempotente por
 * `key`: correrlo dos veces no duplica nada.
 */
export function backfillNotifications(state: RealmState, nowMs: number): boolean {
  state.notifications ??= [];
  const before = state.notifications.length;

  for (const quest of state.quests) {
    // UNA QUEST CERRADA NO VUELVE A LLAMAR A LA PUERTA.
    //
    // Sin esta guarda, el backfill resucitaba en cada lectura el aviso «el
    // frente sigue abierto» de una Quest abandonada, porque miraba el estado de
    // la Battle y nunca el de la Quest.
    if (CLOSED_QUEST_STATUS.has(quest.status)) continue;
    if (quest.status === "draft") {
      addNotification(
        state,
        {
        type: "quest_created",
        title: "Un nuevo pacto aguarda tu sello",
        body: quest.title,
        entityType: "quest",
        entityId: quest.id,
        version: 1,
        backfilled: true,
        },
        nowMs,
      );
    }
    if (quest.status === "waiting_external") {
      addNotification(
        state,
        {
        type: "quest_waiting_external",
        title: "Un frente quedó bloqueado por un tercero",
        body: `«${quest.title}» espera una condición externa.`,
        entityType: "quest",
        entityId: quest.id,
        priority: "high",
        version: quest.version,
        backfilled: true,
        },
        nowMs,
      );
    }
    if (quest.battle && ["awaiting_replan", "awaiting_recovery"].includes(quest.battle.status)) {
      addNotification(
        state,
        {
        type: "battle_lost",
        title: "El plazo venció: puedes replanificar",
        body: `El frente de «${quest.title}» sigue abierto. Nada de lo validado se pierde.`,
        entityType: "quest",
        entityId: quest.id,
        priority: "high",
        version: quest.battle.attempt,
        screen: "battle",
        backfilled: true,
        },
        nowMs,
      );
    }
    if (quest.amendments.some((amendment) => amendment.status === "proposed")) {
      addNotification(
        state,
        {
        type: "quest_amendment_proposed",
        title: "El campo de batalla puede cambiar",
        body: quest.amendments.find((amendment) => amendment.status === "proposed")!.reason,
        entityType: "quest",
        entityId: quest.id,
        priority: "high",
        version: quest.version,
        screen: "battle",
        backfilled: true,
        },
        nowMs,
      );
    }
    if (quest.battle?.pendingRecontract) {
      addNotification(
        state,
        {
        type: "battle_recontract_proposed",
        title: "Nuevo pacto temporal propuesto",
        body: quest.battle.pendingRecontract.reason,
        entityType: "quest",
        entityId: quest.id,
        priority: "high",
        version: quest.version,
        screen: "battle",
        backfilled: true,
        },
        nowMs,
      );
    }
  }

  for (const campaign of state.campaigns) {
    if (campaign.status === "draft") {
      addNotification(
        state,
        {
        type: "campaign_created",
        title: "Una nueva campaña espera tu sello",
        body: campaign.title,
        entityType: "campaign",
        entityId: campaign.id,
        version: 1,
        backfilled: true,
        },
        nowMs,
      );
    }
  }

  for (const obligation of state.recurringObligations ?? []) {
    if (obligation.active && obligationPeriodStatus(obligation, nowMs) === "pending") {
      addNotification(
        state,
        {
        type: "recurring_obligation_due",
        title: obligation.direction === "income" ? "Un ingreso recurrente aguarda registro" : "Una obligación recurrente aguarda",
        body: `${obligation.name}: período ${periodOf(nowMs)} pendiente.`,
        entityType: "obligation",
        entityId: obligation.id,
        priority: "normal",
        version: Number(periodOf(nowMs).replace("-", "")),
        screen: "treasury",
        backfilled: true,
        },
        nowMs,
      );
    }
  }

  return state.notifications.length !== before;
}

function bucketFor(createdAt: string, nowMs: number): NotificationView["bucket"] {
  const created = new Date(createdAt);
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  if (created.getTime() >= startOfToday.getTime()) return "hoy";
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
  if (created.getTime() >= startOfYesterday.getTime()) return "ayer";
  return "anteriores";
}

export interface NotificationQuery {
  unreadOnly?: boolean;
  limit?: number;
  entityType?: NotificationEntityType;
  includeArchived?: boolean;
}

export function notificationViewsFor(state: RealmState, nowMs: number, query: NotificationQuery = {}): NotificationView[] {
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  return (state.notifications ?? [])
    .filter((record) => (query.includeArchived ? true : !record.archivedAt))
    .filter((record) => (query.unreadOnly ? !record.readAt : true))
    .filter((record) => (query.entityType ? record.entityType === query.entityType : true))
    .slice(0, limit)
    .map((record) => ({
      id: record.id,
      type: record.type,
      title: record.title,
      body: record.body,
      entityType: record.entityType,
      entityId: record.entityId,
      priority: record.priority,
      deepLink: record.deepLink,
      createdAt: record.createdAt,
      read: Boolean(record.readAt),
      archived: Boolean(record.archivedAt),
      push: record.push,
      bucket: bucketFor(record.createdAt, nowMs),
    }));
}

export function unreadCount(state: RealmState): number {
  return (state.notifications ?? []).filter((record) => !record.readAt && !record.archivedAt).length;
}


// ---------------------------------------------------------------------------
// LOS AVISOS DE UNA BATTLE MUEREN CON LA BATTLE
//
// «La puerta de Bigle sigue abierta» seguía en la bandeja DESPUÉS de ganarla.
// El aviso nacía correcto —el plazo había vencido de verdad— pero nada lo
// cerraba cuando el frente se cerró: el Centro de Notificaciones sabía crear
// registros y no sabía jubilarlos.
//
// UN AVISO ACTIVO ES UNA COSA QUE TODAVÍA PIDE ALGO. Cuando la Quest termina,
// se abandona, o su Battle se gana, todo lo suyo pasa a historial: sigue
// consultable con `includeArchived`, pero deja de reclamar atención.
// ---------------------------------------------------------------------------

/** Archiva todo aviso activo de una entidad. Devuelve cuántos jubiló. */
export function settleNotificationsFor(state: RealmState, entityId: string, nowMs: number): number {
  const timestamp = isoAt(nowMs);
  let settled = 0;
  for (const record of state.notifications ?? []) {
    if (record.entityId !== entityId || record.archivedAt) continue;
    record.archivedAt = timestamp;
    record.readAt ??= timestamp;
    settled += 1;
  }
  return settled;
}

/**
 * Reconciliación de lectura: ningún aviso activo puede pertenecer a una Quest
 * cerrada ni a una Battle ganada.
 *
 * Vive aquí, en la normalización, y no sólo en el momento de cerrar la Quest,
 * porque los reinos que YA tienen el ruido acumulado —el de Bigle, sin ir más
 * lejos— tienen que limpiarse solos sin migración ni intervención del jugador.
 */
export function settleClosedNotifications(state: RealmState, nowMs: number): boolean {
  let settled = 0;
  for (const quest of state.quests) {
    const closed = CLOSED_QUEST_STATUS.has(quest.status) || quest.battle?.status === "won";
    if (!closed) continue;
    settled += settleNotificationsFor(state, quest.id, nowMs);
  }
  return settled > 0;
}

// ---------------------------------------------------------------------------
// EL CENTRO, DESDE FUERA.
//
// Extraído de `quest-service.ts` (artículo 9). Push es entrega efímera; el
// registro es la verdad. `resend` sólo abre otro intento de entrega: nunca
// recrea la Quest ni un segundo NotificationRecord.
// ---------------------------------------------------------------------------

function requireNotification(state: RealmState, notificationId: string): NotificationRecord {
  const record = (state.notifications ?? []).find((candidate) => candidate.id === notificationId);
  if (!record) throw notFound(`Notificación no encontrada: ${notificationId}`);
  return record;
}

export function markRead(state: RealmState, notificationId: string, nowMs: number): NotificationRecord {
  const record = requireNotification(state, notificationId);
  record.readAt ??= isoAt(nowMs);
  return record;
}

/** Jubilar un aviso NO es borrarlo: sigue consultable con `includeArchived`. */
export function archive(state: RealmState, notificationId: string, nowMs: number): NotificationRecord {
  const record = requireNotification(state, notificationId);
  record.archivedAt ??= isoAt(nowMs);
  record.readAt ??= isoAt(nowMs);
  return record;
}

export function resend(state: RealmState, notificationId: string, nowMs: number): NotificationRecord {
  const record = requireNotification(state, notificationId);
  attemptPush(record, nowMs);
  return record;
}

/** Reenvía el último aviso de una entidad/tipo. No crea uno nuevo. */
export function resendForEntity(
  state: RealmState,
  input: { entityType: NotificationEntityType; entityId: string; notificationType?: NotificationType },
  nowMs: number,
): NotificationRecord {
  const record = (state.notifications ?? []).find(
    (candidate) =>
      candidate.entityId === input.entityId &&
      candidate.entityType === input.entityType &&
      (input.notificationType ? candidate.type === input.notificationType : true),
  );
  if (!record) throw deny("No existe ninguna notificación para esa entidad. Reenviar no crea una nueva.");
  attemptPush(record, nowMs);
  return record;
}
