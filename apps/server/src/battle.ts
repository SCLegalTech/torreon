import { randomUUID } from "node:crypto";
import { emptyAgentSlot } from "./companions.js";
import type {
  AttemptEndReason,
  BattleClock,
  BattleRecord,
  BattleStatus,
  DamageAllocation,
  GameEvent,
  Quest,
  RealmState,
} from "./domain.js";
import {
  archetypeOf,
  buildEncounter,
  enemyPressureRate,
  enemyTarget,
  seededUnit,
  totalPressureRate,
} from "./horde.js";
import { applyDamage, freshParty } from "./party.js";
import { MAX_BATTLE_MINUTES } from "./scale.js";

/**
 * EL RELOJ ES PARTE DEL ENEMIGO — Y LA HORDA NO DESCANSA.
 *
 * La presión ya no son cuatro golpes espaciados: la Horda muerde de forma
 * continua, y el Core la liquida por ventanas para no escribir un evento por
 * segundo. Cerrar la app no la detiene; al volver, el Core cobra lo que faltaba
 * exactamente una vez.
 */

export { MAX_BATTLE_MINUTES, totalPressureRate };

/** Cada cuánto tiempo activo se convierte la presión acumulada en daño. */
export const PRESSURE_WINDOW_MS = 60_000;
/** Multiplicador del golpe crítico. No acorta el reloj: acorta el margen. */
export const CRITICAL_MULTIPLIER = 1.5;

export type BattleResolution = "won" | "awaiting_replan" | "awaiting_recovery";

export function clampBattleMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return MAX_BATTLE_MINUTES;
  return Math.min(MAX_BATTLE_MINUTES, Math.max(1, Math.round(minutes)));
}

export function createBattleRecord(startedAtMs: number, durationMinutes: number): BattleRecord {
  const duration = clampBattleMinutes(durationMinutes);
  const startedAt = new Date(startedAtMs).toISOString();
  const deadlineAt = new Date(startedAtMs + duration * 60_000).toISOString();
  const encounterSeed = randomUUID();
  return {
    attempt: 1,
    attempts: [{ attempt: 1, startedAt, durationMinutes: duration, deadlineAt }],
    startedAt,
    durationMinutes: duration,
    deadlineAt,
    status: "active",
    combatSeed: randomUUID(),
    encounterSeed,
    suspendedMs: 0,
    settledPressureMs: 0,
    appliedCriticalWindows: [],
    party: freshParty(),
    enemies: buildEncounter(encounterSeed),
    agent: emptyAgentSlot(),
  };
}

/**
 * Abre un intento nuevo sobre el MISMO campo de batalla.
 *
 * Preserva grupo, caídos, escudo, enemigos y semilla del encuentro. Lo único
 * que se repacta es el tiempo: replanificar no resucita a nadie ni regala
 * enemigos más fáciles.
 */
export function openAttempt(record: BattleRecord, startedAtMs: number, durationMinutes: number, previousReason: AttemptEndReason): void {
  const duration = clampBattleMinutes(durationMinutes);
  const startedAt = new Date(startedAtMs).toISOString();
  const current = record.attempts.find((attempt) => attempt.attempt === record.attempt);
  if (current && !current.endedAt) {
    current.endedAt = startedAt;
    current.endReason = previousReason;
  }
  record.attempt += 1;
  record.startedAt = startedAt;
  record.durationMinutes = duration;
  record.deadlineAt = new Date(startedAtMs + duration * 60_000).toISOString();
  record.status = "active";
  record.suspendedMs = 0;
  delete record.suspendedAt;
  delete record.endedAt;
  delete record.pendingRecontract;
  // El cursor de presión se reinicia con el reloj; las heridas no.
  record.settledPressureMs = 0;
  record.appliedCriticalWindows = [];
  record.attempts.push({ attempt: record.attempt, startedAt, durationMinutes: duration, deadlineAt: record.deadlineAt });
}

export function battleClock(record: BattleRecord, nowMs: number): BattleClock {
  const totalMs = record.durationMinutes * 60_000;
  const startedMs = Date.parse(record.startedAt);
  const openSuspension = record.suspendedAt ? Math.max(0, nowMs - Date.parse(record.suspendedAt)) : 0;
  const elapsedMs = Math.max(0, nowMs - startedMs - record.suspendedMs - openSuspension);
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  return {
    startedAt: record.startedAt,
    deadlineAt: openSuspension > 0 ? new Date(nowMs + remainingMs).toISOString() : record.deadlineAt,
    durationMinutes: record.durationMinutes,
    serverNow: new Date(nowMs).toISOString(),
    elapsedMs,
    remainingMs,
    elapsedRatio: totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0,
    expired: remainingMs === 0,
    suspended: record.status === "suspended_external" || Boolean(record.suspendedAt),
  };
}

export function hordeIsDown(record: BattleRecord): boolean {
  return record.enemies.every((enemy) => enemy.status === "ko");
}

/**
 * UNA SOLA FUENTE AUTORITATIVA DEL ESTADO DE LA BATALLA.
 *
 * Nunca puede ocurrir `won` en un sitio y `active` en otro. La Quest manda: si
 * el contrato quedó validado, la Battle está ganada mire quien la mire; si el
 * frente espera a un tercero, está suspendida; si la Quest se abandonó, no
 * queda ningún combate vivo que pintar.
 */
export function battleStatusOf(quest: Quest): BattleStatus | "pending" {
  const record = quest.battle;
  if (!record) return "pending";
  if (quest.status === "completed") return "won";
  if (quest.status === "abandoned") return record.status === "active" ? "awaiting_replan" : record.status;
  if (quest.status === "waiting_external" && record.status === "active") return "suspended_external";
  return record.status;
}

/**
 * Alinea el registro persistido con esa única verdad.
 *
 * No inventa nada: sólo impide que un estado a medias sobreviva a un fallo, a
 * un redeploy o a una migración. Se aplica al leer y al cerrar una Battle.
 */
export function reconcileBattleProjection(quest: Quest, nowMs = Date.now()): boolean {
  const record = quest.battle;
  if (!record) return false;
  const authoritative = battleStatusOf(quest);
  if (authoritative === "pending") return false;
  let changed = record.status !== authoritative;
  record.status = authoritative;

  if (authoritative === "won") {
    // La forma de una victoria se impone entera, no sólo la etiqueta: un
    // contrato validado al 100% no puede dejar un enemigo en pie, un reloj
    // suspendido ni un intento abierto en NINGUNA proyección.
    const timestamp = new Date(nowMs).toISOString();
    for (const enemy of record.enemies) {
      if (enemy.status === "ko" && enemy.health === 0) continue;
      enemy.health = 0;
      enemy.status = "ko";
      changed = true;
    }
    if (!record.endedAt) {
      record.endedAt = timestamp;
      changed = true;
    }
    record.hordeNeutralizedAt ??= timestamp;
    if (record.suspendedAt || record.pendingRecontract) changed = true;
    delete record.suspendedAt;
    delete record.pendingRecontract;
    const attempt = record.attempts.find((candidate) => candidate.attempt === record.attempt);
    if (attempt && !attempt.endedAt) {
      attempt.endedAt = timestamp;
      attempt.endReason = "won";
      changed = true;
    }
  }
  return changed;
}

function pushGameEvent(state: RealmState, event: Omit<GameEvent, "id">): void {
  state.gameEvents.unshift({ id: randomUUID(), ...event });
  state.gameEvents = state.gameEvents.slice(0, 200);
}

/**
 * Sincroniza la suspensión con la realidad de la quest.
 *
 * No hay botón `PAUSAR`: la presión sólo se detiene por un bloqueo externo
 * reconocido. Y una Battle suspendida NO puede seguir diciendo `active`: el
 * Core ya soltó el frente, así que el renderer no debe pintar un combate vivo.
 * Al desbloquear se reanuda el MISMO combate: ni HP ni formación se tocan.
 */
export function syncSuspension(quest: Quest, record: BattleRecord, nowMs: number): boolean {
  const shouldSuspend = quest.status === "waiting_external";
  if (shouldSuspend && record.status === "active") {
    record.suspendedAt = new Date(nowMs).toISOString();
    record.status = "suspended_external";
    return true;
  }
  if (!shouldSuspend && record.status === "suspended_external") {
    if (record.suspendedAt) {
      const suspended = Math.max(0, nowMs - Date.parse(record.suspendedAt));
      record.suspendedMs += suspended;
      record.deadlineAt = new Date(Date.parse(record.deadlineAt) + suspended).toISOString();
      delete record.suspendedAt;
    }
    record.status = "active";
    return true;
  }
  return false;
}

export interface BattleTickOutcome {
  changed: boolean;
  windows: number;
  damage: number;
  resolved: Array<{ questId: string; status: BattleResolution }>;
}

/**
 * Liquida la presión acumulada.
 *
 * Cada enemigo vivo aporta su ritmo por minuto; el total se cobra por ventanas
 * de un minuto de reloj activo, con UN evento por ventana que lleva el
 * desglose. Un enemigo caído deja de aportar en cuanto cae, así que atacar
 * cambia de verdad la Battle.
 */
function settlePressure(state: RealmState, quest: Quest, record: BattleRecord, nowMs: number): { windows: number; damage: number } {
  const clock = battleClock(record, nowMs);
  const settledWindows = Math.floor(record.settledPressureMs / PRESSURE_WINDOW_MS);
  const elapsedWindows = Math.floor(clock.elapsedMs / PRESSURE_WINDOW_MS);
  if (elapsedWindows <= settledWindows) return { windows: 0, damage: 0 };

  let totalDamage = 0;
  let windows = 0;
  const timestamp = new Date(nowMs).toISOString();

  for (let window = settledWindows + 1; window <= elapsedWindows; window += 1) {
    if (hordeIsDown(record) || record.party.marques.health === 0) break;
    const allocations: DamageAllocation[] = [];

    for (const enemy of record.enemies) {
      if (enemy.status !== "active") continue;
      if (record.party.marques.health === 0) break;
      const archetype = archetypeOf(enemy);
      const aura = record.enemies
        .filter((candidate) => candidate.status === "active" && candidate.id !== enemy.id)
        .reduce((sum, candidate) => sum + (archetypeOf(candidate)?.auraPressureBonus ?? 0), 0);
      const critical = seededUnit(record.combatSeed, "crit", window, enemy.id) < enemy.criticalChance;
      const base = enemyPressureRate(enemy) * (1 + aura);
      const damage = Math.max(1, Math.round(base * (critical ? CRITICAL_MULTIPLIER : 1)));
      const target = enemyTarget(enemy, record.party, record.combatSeed, window);
      const { absorbed, ko } = applyDamage(record.party, target, damage, archetype?.shieldBreak ?? 1);

      // La Sanguijuela convierte parte del daño que causa en vida propia.
      if (archetype?.lifeDrain) {
        enemy.health = Math.min(enemy.maxHealth, enemy.health + Math.round(damage * archetype.lifeDrain));
      }

      allocations.push({
        sourceEnemyId: enemy.id,
        sourceName: enemy.name,
        target,
        damage,
        absorbed,
        critical,
        abilityId: archetype?.abilityId,
      });
      totalDamage += damage;

      if (ko) {
        pushGameEvent(state, {
          type: "party_member_ko",
          questId: quest.id,
          damage: 0,
          target,
          battleAttempt: record.attempt,
          message: `${record.party[target].name} cae en el frente.`,
          createdAt: timestamp,
        });
      }
    }

    if (allocations.length > 0) {
      const critical = allocations.find((entry) => entry.critical);
      const windowDamage = allocations.reduce((sum, entry) => sum + entry.damage, 0);
      if (critical) record.appliedCriticalWindows.push(window);
      pushGameEvent(state, {
        type: "horde_pressure",
        questId: quest.id,
        damage: windowDamage,
        reason: "time_pressure",
        attackIndex: window,
        battleAttempt: record.attempt,
        allocations,
        critical: Boolean(critical),
        message: critical
          ? `Minuto ${window}: ${critical.sourceName} conecta un CRÍTICO sobre ${record.party[critical.target].name} (-${critical.damage}).`
          : `Minuto ${window}: la Horda presiona por ${windowDamage}.`,
        createdAt: timestamp,
      });
      windows += 1;
    }
    record.settledPressureMs = window * PRESSURE_WINDOW_MS;
  }

  return { windows, damage: totalDamage };
}

/**
 * Aplica todo lo que el reloj debía haber hecho mientras nadie miraba.
 *
 * Idempotente por construcción: la ventana ya liquidada vive en
 * `settledPressureMs`, así que refrescar, reabrir la app o consultar por MCP
 * no puede cobrar dos veces el mismo minuto.
 */
export function advanceBattles(state: RealmState, nowMs: number): BattleTickOutcome {
  const outcome: BattleTickOutcome = { changed: false, windows: 0, damage: 0, resolved: [] };

  for (const quest of state.quests) {
    const record = quest.battle;
    if (!record || !["active", "suspended_external"].includes(record.status)) continue;
    if (["completed", "abandoned"].includes(quest.status)) continue;

    if (syncSuspension(quest, record, nowMs)) outcome.changed = true;
    // Suspendida no muerde: ni presión, ni plazo, ni resolución.
    if (record.status !== "active") continue;

    // Con la Horda neutralizada el reloj deja de morder, pero el contrato sigue.
    if (!hordeIsDown(record)) {
      const settled = settlePressure(state, quest, record, nowMs);
      if (settled.windows > 0) {
        outcome.changed = true;
        outcome.windows += settled.windows;
        outcome.damage += settled.damage;
      }
    }

    const clock = battleClock(record, nowMs);
    if (record.party.marques.health === 0) {
      resolve(state, quest, record, "awaiting_recovery", nowMs);
      outcome.changed = true;
      outcome.resolved.push({ questId: quest.id, status: "awaiting_recovery" });
    } else if (clock.expired) {
      resolve(state, quest, record, "awaiting_replan", nowMs);
      outcome.changed = true;
      outcome.resolved.push({ questId: quest.id, status: "awaiting_replan" });
    }
  }

  return outcome;
}

/**
 * Cierra el intento en curso.
 *
 * Ni el plazo vencido ni la caída del Marqués borran evidencia, impacto
 * validado, XP, Aura, dinero, historial, inventario ni Realm. El frente sigue
 * abierto: lo que terminó fue este intento.
 */
export function resolve(state: RealmState, quest: Quest, record: BattleRecord, status: BattleResolution, nowMs: number): void {
  if (record.status !== "active") return;
  const timestamp = new Date(nowMs).toISOString();
  record.status = status;
  record.endedAt = timestamp;
  if (record.suspendedAt) {
    record.suspendedMs += Math.max(0, nowMs - Date.parse(record.suspendedAt));
    delete record.suspendedAt;
  }
  const attempt = record.attempts.find((candidate) => candidate.attempt === record.attempt);
  if (attempt && !attempt.endedAt) {
    attempt.endedAt = timestamp;
    attempt.endReason = status === "won" ? "won" : status === "awaiting_recovery" ? "player_ko" : "timeout";
  }

  const clock = battleClock(record, nowMs);
  pushGameEvent(state, {
    type: status === "won" ? "battle_won" : "battle_lost",
    questId: quest.id,
    damage: 0,
    battleAttempt: record.attempt,
    message:
      status === "won"
        ? `Victoria en «${quest.title}» con ${Math.floor(clock.remainingMs / 1000)}s de margen.`
        : status === "awaiting_recovery"
          ? `El Marqués cayó en «${quest.title}». Hay que levantarlo antes de volver.`
          : `El tiempo pactado terminó con la Horda viva en «${quest.title}».`,
    createdAt: timestamp,
  });
  state.events.unshift({
    id: randomUUID(),
    type: status === "won" ? "battle_won" : "battle_lost",
    entityType: "quest",
    entityId: quest.id,
    questId: quest.id,
    message:
      status === "won"
        ? `«${quest.title}» cayó antes del plazo pactado.`
        : status === "awaiting_recovery"
          ? `El Marqués cayó en «${quest.title}». El frente sigue abierto y la evidencia validada se conserva.`
          : `El plazo de «${quest.title}» se agotó. El frente sigue abierto: nada de lo validado se pierde.`,
    createdAt: timestamp,
  });
  state.events = state.events.slice(0, 100);
}

/** ¿Hay algo que el reloj deba cobrar o resolver antes de responder? */
export function needsAdvance(state: RealmState, nowMs: number): boolean {
  return state.quests.some((quest) => {
    const record = quest.battle;
    if (!record || !["active", "suspended_external"].includes(record.status)) return false;
    if (["completed", "abandoned"].includes(quest.status)) return false;
    // Desajuste entre lo que dice la quest y lo que dice la Battle: hay que sincronizar.
    if ((record.status === "suspended_external") !== (quest.status === "waiting_external")) return true;
    if (record.status !== "active") return false;
    if (record.party.marques.health === 0) return true;
    const clock = battleClock(record, nowMs);
    if (clock.expired) return true;
    if (hordeIsDown(record)) return false;
    return Math.floor(clock.elapsedMs / PRESSURE_WINDOW_MS) > Math.floor(record.settledPressureMs / PRESSURE_WINDOW_MS);
  });
}
