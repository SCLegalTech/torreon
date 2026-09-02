import { randomUUID } from "node:crypto";
import type { BattleClock, BattleRecord, GameEvent, Quest, RealmState } from "./domain.js";
import { MAX_BATTLE_MINUTES } from "./scale.js";

/**
 * EL RELOJ ES PARTE DEL ENEMIGO.
 *
 * Una Battle es la representación temporizada de una Quest. El reloj arranca
 * SÓLO al iniciar —no al redactar el borrador ni al aceptar el contrato— y
 * desde entonces la autoridad del tiempo es el servidor: cerrar la app,
 * bloquear el teléfono o cambiar de pantalla no congela nada. Al volver, el
 * Core calcula cuánto tiempo pasó de verdad y cobra lo que faltaba.
 */

/** Cada umbral cruzado cobra su daño una sola vez. 10 + 20 + 30 + 40 = 100. */
export const TIME_PRESSURE_SCHEDULE: ReadonlyArray<{ threshold: number; damage: number }> = [
  { threshold: 0.25, damage: 10 },
  { threshold: 0.5, damage: 20 },
  { threshold: 0.75, damage: 30 },
  { threshold: 1, damage: 40 },
];

export { MAX_BATTLE_MINUTES };

export function clampBattleMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return MAX_BATTLE_MINUTES;
  return Math.min(MAX_BATTLE_MINUTES, Math.max(1, Math.round(minutes)));
}

export function createBattleRecord(startedAtMs: number, durationMinutes: number, attempt = 1): BattleRecord {
  const duration = clampBattleMinutes(durationMinutes);
  return {
    attempt,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMinutes: duration,
    deadlineAt: new Date(startedAtMs + duration * 60_000).toISOString(),
    status: "active",
    appliedThresholds: [],
    suspendedMs: 0,
  };
}

/**
 * Tiempo transcurrido real, descontando lo que estuvo legítimamente suspendido.
 * La suspensión no la pide un botón: la produce un bloqueo externo reconocido.
 */
export function battleClock(record: BattleRecord, nowMs: number): BattleClock {
  const totalMs = record.durationMinutes * 60_000;
  const startedMs = Date.parse(record.startedAt);
  const openSuspension = record.suspendedAt ? Math.max(0, nowMs - Date.parse(record.suspendedAt)) : 0;
  const elapsedMs = Math.max(0, nowMs - startedMs - record.suspendedMs - openSuspension);
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  return {
    startedAt: record.startedAt,
    // Con la presión suspendida, la fecha límite se proyecta desde ahora.
    deadlineAt: openSuspension > 0 ? new Date(nowMs + remainingMs).toISOString() : record.deadlineAt,
    durationMinutes: record.durationMinutes,
    serverNow: new Date(nowMs).toISOString(),
    elapsedMs,
    remainingMs,
    elapsedRatio: totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0,
    expired: remainingMs === 0,
    suspended: Boolean(record.suspendedAt),
  };
}

/** Umbrales ya cruzados por el reloj que todavía no se han cobrado. */
export function pendingTimeAttacks(record: BattleRecord, nowMs: number): Array<{ threshold: number; damage: number }> {
  if (record.status !== "active") return [];
  const { elapsedRatio } = battleClock(record, nowMs);
  return TIME_PRESSURE_SCHEDULE.filter(
    (entry) => elapsedRatio >= entry.threshold && !record.appliedThresholds.includes(entry.threshold),
  );
}

function enemyHealthOf(quest: Quest): number {
  return Math.max(0, 100 - quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0));
}

function playerHealthOf(quest: Quest, gameEvents: GameEvent[]): number {
  const attempt = quest.battle?.attempt ?? 1;
  const damage = gameEvents
    .filter((event) => event.questId === quest.id && event.type === "horde_attack" && (event.battleAttempt ?? 1) === attempt)
    .reduce((sum, event) => sum + event.damage, 0);
  return Math.max(0, 100 - damage);
}

/**
 * Sincroniza la suspensión con la realidad de la quest.
 *
 * No hay botón `PAUSAR`. La presión sólo se suspende cuando la propia quest
 * está en `waiting_external`, es decir cuando el sistema reconoce que no hay
 * acción disponible para el Marqués.
 */
function syncSuspension(quest: Quest, record: BattleRecord, nowMs: number): boolean {
  const shouldSuspend = quest.status === "waiting_external";
  if (shouldSuspend && !record.suspendedAt) {
    record.suspendedAt = new Date(nowMs).toISOString();
    return true;
  }
  if (!shouldSuspend && record.suspendedAt) {
    const suspended = Math.max(0, nowMs - Date.parse(record.suspendedAt));
    record.suspendedMs += suspended;
    record.deadlineAt = new Date(Date.parse(record.deadlineAt) + suspended).toISOString();
    delete record.suspendedAt;
    return true;
  }
  return false;
}

export interface BattleTickOutcome {
  changed: boolean;
  attacks: Array<{ questId: string; threshold: number; damage: number }>;
  resolved: Array<{ questId: string; status: "won" | "lost" }>;
}

/**
 * Aplica todo lo que el reloj debía haber hecho mientras nadie miraba.
 *
 * Es idempotente por construcción: la combinación `questId + threshold` vive en
 * `appliedThresholds`, así que refrescar, reabrir la app o consultar por MCP no
 * puede repetir un ataque.
 */
export function advanceBattles(state: RealmState, nowMs: number): BattleTickOutcome {
  const outcome: BattleTickOutcome = { changed: false, attacks: [], resolved: [] };

  for (const quest of state.quests) {
    const record = quest.battle;
    if (!record || record.status !== "active") continue;
    // Una quest cerrada no tiene frente abierto: el reloj deja de morder.
    if (["completed", "abandoned"].includes(quest.status)) continue;

    if (syncSuspension(quest, record, nowMs)) outcome.changed = true;

    // Si la Horda ya cayó, el reloj deja de ser enemigo: no hay más ataques.
    if (enemyHealthOf(quest) === 0) {
      resolve(state, quest, record, "won", nowMs);
      outcome.changed = true;
      outcome.resolved.push({ questId: quest.id, status: "won" });
      continue;
    }

    for (const attack of pendingTimeAttacks(record, nowMs)) {
      record.appliedThresholds.push(attack.threshold);
      const timestamp = new Date(nowMs).toISOString();
      const lifeEventId = randomUUID();
      const reason = "time_pressure";
      state.lifeEvents.unshift({
        id: lifeEventId,
        type: "unexpected_requirement",
        questId: quest.id,
        reason: `El tiempo pactado avanzó hasta el ${Math.round(attack.threshold * 100)}% sin cerrar la campaña.`,
        createdAt: timestamp,
      });
      state.gameEvents.unshift({
        id: randomUUID(),
        type: "horde_attack",
        sourceLifeEventId: lifeEventId,
        questId: quest.id,
        damage: attack.damage,
        reason,
        threshold: attack.threshold,
        battleAttempt: record.attempt,
        message: `La Horda aprovecha el reloj (${Math.round(attack.threshold * 100)}%): -${attack.damage} HP.`,
        createdAt: timestamp,
      });
      state.lifeEvents = state.lifeEvents.slice(0, 200);
      state.gameEvents = state.gameEvents.slice(0, 200);
      state.events.unshift({
        id: randomUUID(),
        type: "horde_attack",
        questId: quest.id,
        message: `El reloj llegó al ${Math.round(attack.threshold * 100)}%: la Horda golpea por ${attack.damage} HP.`,
        createdAt: timestamp,
      });
      state.events = state.events.slice(0, 100);
      outcome.changed = true;
      outcome.attacks.push({ questId: quest.id, threshold: attack.threshold, damage: attack.damage });
    }

    const clock = battleClock(record, nowMs);
    const playerDown = playerHealthOf(quest, state.gameEvents) === 0;
    if (playerDown || (clock.expired && enemyHealthOf(quest) > 0)) {
      resolve(state, quest, record, "lost", nowMs);
      outcome.changed = true;
      outcome.resolved.push({ questId: quest.id, status: "lost" });
    }
  }

  return outcome;
}

/**
 * Cierra la Battle.
 *
 * Perder NO borra evidencia, impacto validado, XP, Aura, dinero, historial ni
 * Realm. Sólo significa que ESTA Battle fue perdida.
 */
export function resolve(state: RealmState, quest: Quest, record: BattleRecord, status: "won" | "lost", nowMs: number): void {
  if (record.status !== "active") return;
  const timestamp = new Date(nowMs).toISOString();
  record.status = status;
  record.endedAt = timestamp;
  if (record.suspendedAt) {
    record.suspendedMs += Math.max(0, nowMs - Date.parse(record.suspendedAt));
    delete record.suspendedAt;
  }
  const clock = battleClock(record, nowMs);
  state.gameEvents.unshift({
    id: randomUUID(),
    type: status === "won" ? "battle_won" : "battle_lost",
    questId: quest.id,
    damage: 0,
    battleAttempt: record.attempt,
    message:
      status === "won"
        ? `Victoria en «${quest.title}» con ${Math.floor(clock.remainingMs / 1000)}s de margen.`
        : `El tiempo pactado terminó con la Horda viva en «${quest.title}».`,
    createdAt: timestamp,
  });
  state.gameEvents = state.gameEvents.slice(0, 200);
  state.events.unshift({
    id: randomUUID(),
    type: status === "won" ? "battle_won" : "battle_lost",
    questId: quest.id,
    message:
      status === "won"
        ? `«${quest.title}» cayó antes del plazo pactado.`
        : `Derrota temporal: «${quest.title}» agotó sus ${record.durationMinutes} min. La evidencia validada se conserva.`,
    createdAt: timestamp,
  });
  state.events = state.events.slice(0, 100);
}

/** ¿Hay algo que el reloj deba cobrar o resolver antes de responder? */
export function needsAdvance(state: RealmState, nowMs: number): boolean {
  return state.quests.some((quest) => {
    const record = quest.battle;
    if (!record || record.status !== "active") return false;
    if (["completed", "abandoned"].includes(quest.status)) return false;
    if (Boolean(record.suspendedAt) !== (quest.status === "waiting_external")) return true;
    if (enemyHealthOf(quest) === 0) return true;
    if (pendingTimeAttacks(record, nowMs).length > 0) return true;
    if (playerHealthOf(quest, state.gameEvents) === 0) return true;
    return battleClock(record, nowMs).expired;
  });
}
