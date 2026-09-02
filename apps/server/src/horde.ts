import type { EnemyCombatant, EnemyPosition, EnemyRole, PartyMemberId, PartyState, TargetPolicy } from "./domain.js";

/**
 * LA HORDA YA NO ES UNA BARRA.
 *
 * Es una formación de cuatro. Un arquero puede saltarse a Roko, un asesino
 * puede caer sobre Cordera y un saboteador puede interferir con el Agente. Por
 * eso el daño deja de ser abstracto: cada golpe tiene autor y destino.
 *
 * El registro es data-driven a propósito: añadir un arquetipo no debería
 * obligar a tocar el motor.
 */

export interface HordeArchetype {
  id: string;
  name: string;
  role: EnemyRole;
  position: EnemyPosition;
  /** Peso relativo de HP dentro del encuentro. El total siempre se ajusta a 100. */
  healthWeight: number;
  /** Daño por minuto que aporta mientras siga en pie. */
  pressureRate: number;
  criticalChance: number;
  targetPolicy: TargetPolicy;
  abilityId?: string;
  abilityName?: string;
  /** Sube la presión del resto del encuentro mientras viva. */
  auraPressureBonus?: number;
  /** Convierte parte de su daño en vida propia. */
  lifeDrain?: number;
  /** Cuanto menos vida le queda, más presión produce. */
  enrage?: boolean;
  /** Golpea el escudo de Roko con ventaja. */
  shieldBreak?: number;
  /** Puede recortar una vez el combo del Agente. */
  jamsAssist?: boolean;
  /** Como máximo uno por Battle. */
  unique?: boolean;
}

export const HORDE_POOL: HordeArchetype[] = [
  {
    id: "h01_ash_guardian",
    name: "Guardián de Ceniza",
    role: "tank",
    position: "front",
    healthWeight: 30,
    pressureRate: 0.9,
    criticalChance: 0.1,
    targetPolicy: "frontline",
    abilityId: "ash_wall",
    abilityName: "Muro de Ceniza",
  },
  {
    id: "h02_void_archer",
    name: "Arquero del Vacío",
    role: "ranged",
    position: "back",
    healthWeight: 22,
    pressureRate: 1.1,
    criticalChance: 0.15,
    // Dispara POR ENCIMA de Roko: la retaguardia deja de estar a salvo.
    targetPolicy: "backline",
    abilityId: "backline_shot",
    abilityName: "Disparo de Retaguardia",
  },
  {
    id: "h03_shadow_stalker",
    name: "Acechador Sombrío",
    role: "assassin",
    position: "back",
    healthWeight: 20,
    pressureRate: 1.0,
    criticalChance: 0.28,
    targetPolicy: "lowest_health",
    abilityId: "hunt_the_weak",
    abilityName: "Caza al Herido",
  },
  {
    id: "h04_shield_breaker",
    name: "Rompeescudos",
    role: "breaker",
    position: "front",
    healthWeight: 24,
    pressureRate: 1.0,
    criticalChance: 0.12,
    targetPolicy: "shield_first",
    abilityId: "shield_break",
    abilityName: "Quiebre de Escudo",
    shieldBreak: 2,
  },
  {
    id: "h05_horde_shaman",
    name: "Chamán de la Horda",
    role: "support",
    position: "back",
    healthWeight: 22,
    pressureRate: 0.6,
    criticalChance: 0.08,
    targetPolicy: "weighted",
    abilityId: "war_chant",
    abilityName: "Canto de Guerra",
    auraPressureBonus: 0.2,
    unique: true,
  },
  {
    id: "h06_iron_leech",
    name: "Sanguijuela de Hierro",
    role: "drain",
    position: "front",
    healthWeight: 24,
    pressureRate: 1.0,
    criticalChance: 0.12,
    targetPolicy: "weighted",
    abilityId: "life_drain",
    abilityName: "Drenaje Vital",
    lifeDrain: 0.4,
  },
  {
    id: "h07_dread_herald",
    name: "Heraldo del Agobio",
    role: "mage",
    position: "back",
    healthWeight: 20,
    pressureRate: 0.8,
    criticalChance: 0.12,
    targetPolicy: "weighted",
    abilityId: "oppressive_aura",
    abilityName: "Aura Opresiva",
    auraPressureBonus: 0.25,
  },
  {
    id: "h08_saboteur",
    name: "Saboteador",
    role: "disruptor",
    position: "back",
    healthWeight: 20,
    pressureRate: 0.9,
    criticalChance: 0.14,
    targetPolicy: "backline",
    abilityId: "jam_assist",
    abilityName: "Interferencia",
    jamsAssist: true,
  },
  {
    id: "h09_breach_berserker",
    name: "Berserker de la Brecha",
    role: "berserker",
    position: "front",
    healthWeight: 26,
    pressureRate: 0.9,
    criticalChance: 0.18,
    targetPolicy: "weighted",
    abilityId: "enrage",
    abilityName: "Frenesí",
    enrage: true,
  },
  {
    id: "h10_ruin_herald",
    name: "Heraldo de Ruina",
    role: "captain",
    position: "front",
    healthWeight: 34,
    pressureRate: 1.1,
    criticalChance: 0.16,
    targetPolicy: "frontline",
    abilityId: "command",
    abilityName: "Mando",
    auraPressureBonus: 0.15,
    unique: true,
  },
];

/** La Horda entera vale exactamente el contrato: 100 puntos de impacto. */
export const HORDE_TOTAL_HEALTH = 100;
export const ENCOUNTER_SIZE = 4;

const FRONTLINE_ROLES = new Set<EnemyRole>(["tank", "breaker", "drain", "berserker", "captain"]);
const BACKLINE_ROLES = new Set<EnemyRole>(["ranged", "assassin", "support", "mage", "disruptor"]);

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 0 <= valor < 1, determinista para la misma clave. */
export function seededUnit(seed: string, ...parts: Array<string | number>): number {
  return hash32(`${seed}:${parts.join(":")}`) / 0x1_0000_0000;
}

/**
 * Construye el encuentro a partir de la semilla.
 *
 * No son cuatro enteros al azar: hay restricciones para que el campo tenga
 * sentido —nunca cuatro chamanes—, y la selección es reproducible, así que
 * replanificar no regala enemigos más fáciles.
 */
export function buildEncounter(encounterSeed: string): EnemyCombatant[] {
  const ordered = HORDE_POOL.map((archetype, index) => ({
    archetype,
    roll: seededUnit(encounterSeed, "pick", index),
  })).sort((a, b) => a.roll - b.roll);

  const chosen: HordeArchetype[] = [];
  let uniques = 0;
  let supports = 0;

  const canTake = (archetype: HordeArchetype): boolean => {
    if (chosen.some((candidate) => candidate.id === archetype.id)) return false;
    if (archetype.unique && uniques >= 1) return false;
    if (archetype.role === "support" && supports >= 1) return false;
    return true;
  };

  const take = (archetype: HordeArchetype) => {
    chosen.push(archetype);
    if (archetype.unique) uniques += 1;
    if (archetype.role === "support") supports += 1;
  };

  // Al menos un frente y al menos una retaguardia: si no, no hay formación.
  const firstFront = ordered.find((entry) => FRONTLINE_ROLES.has(entry.archetype.role) && canTake(entry.archetype));
  if (firstFront) take(firstFront.archetype);
  const firstBack = ordered.find((entry) => BACKLINE_ROLES.has(entry.archetype.role) && canTake(entry.archetype));
  if (firstBack) take(firstBack.archetype);
  for (const entry of ordered) {
    if (chosen.length >= ENCOUNTER_SIZE) break;
    if (canTake(entry.archetype)) take(entry.archetype);
  }

  // El presupuesto de dificultad es fijo: la complejidad viene de los roles,
  // no de cuadruplicar el daño bruto.
  const totalWeight = chosen.reduce((sum, archetype) => sum + archetype.healthWeight, 0);
  const health = chosen.map((archetype) => Math.max(1, Math.floor((archetype.healthWeight / totalWeight) * HORDE_TOTAL_HEALTH)));
  let remainder = HORDE_TOTAL_HEALTH - health.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % health.length) {
    health[index] += 1;
    remainder -= 1;
  }

  return chosen.map((archetype, index) => ({
    id: `${archetype.id}#${index + 1}`,
    archetypeId: archetype.id,
    name: archetype.name,
    role: archetype.role,
    position: archetype.position,
    health: health[index],
    maxHealth: health[index],
    status: "active" as const,
    pressureRate: archetype.pressureRate,
    criticalChance: archetype.criticalChance,
    targetPolicy: archetype.targetPolicy,
    abilityId: archetype.abilityId,
    abilityName: archetype.abilityName,
  }));
}

/**
 * Construye la formación conservando la vida que la Horda YA tenía.
 *
 * Al migrar una Battle anterior al 4v4, el enemigo no puede volver a nacer
 * entero: se genera el encuentro con sus máximos y después se reparte entre
 * ellos el HP restante histórico. Si al jugador le quedaban 10 puntos por
 * derribar, siguen siendo 10.
 */
export function backfillEncounter(encounterSeed: string, remainingHealth: number): EnemyCombatant[] {
  const enemies = buildEncounter(encounterSeed);
  const total = enemies.reduce((sum, enemy) => sum + enemy.maxHealth, 0);
  let left = Math.max(0, Math.min(total, Math.round(remainingHealth)));
  if (left === total) return enemies;

  // Se llena de atrás hacia delante: caen primero los que ya estaban rotos.
  for (let index = enemies.length - 1; index >= 0; index -= 1) {
    const enemy = enemies[index];
    const health = Math.min(enemy.maxHealth, left);
    enemy.health = health;
    enemy.status = health === 0 ? "ko" : "active";
    left -= health;
  }
  return enemies;
}

export function archetypeOf(enemy: EnemyCombatant): HordeArchetype | undefined {
  return HORDE_POOL.find((candidate) => candidate.id === enemy.archetypeId);
}

/** Presión total por minuto de la Horda viva, con sus auras y su frenesí. */
export function totalPressureRate(enemies: EnemyCombatant[]): number {
  const alive = enemies.filter((enemy) => enemy.status === "active");
  if (alive.length === 0) return 0;
  const aura = alive.reduce((sum, enemy) => sum + (archetypeOf(enemy)?.auraPressureBonus ?? 0), 0);
  return alive.reduce((sum, enemy) => sum + enemyPressureRate(enemy), 0) * (1 + aura);
}

/** Un berserker duele más cuanto menos vida le queda. */
export function enemyPressureRate(enemy: EnemyCombatant): number {
  if (enemy.status !== "active") return 0;
  const archetype = archetypeOf(enemy);
  if (!archetype?.enrage) return enemy.pressureRate;
  const missing = 1 - enemy.health / enemy.maxHealth;
  return enemy.pressureRate * (1 + missing);
}

const BACKLINE_MEMBERS: PartyMemberId[] = ["marques", "cordera"];
const PARTY_ORDER: PartyMemberId[] = ["roko", "marques", "cordera"];

/**
 * A quién golpea este enemigo, ahora mismo.
 *
 * Roko sigue siendo guardia —recibe lo cuerpo a cuerpo y mitiga con escudo—,
 * pero no puede interceptar una flecha del Vacío ni el salto de un asesino.
 */
export function enemyTarget(enemy: EnemyCombatant, party: PartyState, seed: string, window: number): PartyMemberId {
  const alive = PARTY_ORDER.filter((id) => party[id].health > 0);
  if (alive.length === 0) return "marques";
  const pick = (candidates: PartyMemberId[]): PartyMemberId => {
    const viable = candidates.filter((id) => alive.includes(id));
    if (viable.length === 0) return alive[0];
    return viable[Math.floor(seededUnit(seed, enemy.id, window, "target") * viable.length) % viable.length];
  };

  switch (enemy.targetPolicy) {
    case "frontline":
      return alive.includes("roko") ? "roko" : pick(["marques", "cordera"]);
    case "backline":
      return pick(BACKLINE_MEMBERS);
    case "lowest_health":
      return alive.reduce((lowest, id) =>
        party[id].health / party[id].maxHealth < party[lowest].health / party[lowest].maxHealth ? id : lowest,
      );
    case "shield_first":
      return alive.includes("roko") ? "roko" : pick(["marques", "cordera"]);
    default: {
      // Reparto ponderado: Roko aguanta más, pero no lo aguanta todo.
      const roll = seededUnit(seed, enemy.id, window, "weighted");
      if (alive.includes("roko")) {
        if (roll < 0.5) return "roko";
        if (roll < 0.85) return pick(["marques"]);
        return pick(["cordera"]);
      }
      return roll < 0.65 ? pick(["marques"]) : pick(["cordera"]);
    }
  }
}

/**
 * A qué enemigo dispara el Marqués.
 *
 * Sin micromanagement: primero lo que bloquea el paso, después la mayor
 * amenaza, y el sobrante desborda al siguiente. El daño no se pierde.
 */
export function distributeEnemyDamage(enemies: EnemyCombatant[], amount: number): Array<{ enemy: EnemyCombatant; damage: number; killed: boolean }> {
  const hits: Array<{ enemy: EnemyCombatant; damage: number; killed: boolean }> = [];
  let remaining = Math.max(0, Math.round(amount));
  while (remaining > 0) {
    const alive = enemies.filter((enemy) => enemy.status === "active" && enemy.health > 0);
    if (alive.length === 0) break;
    const target = threatTarget(alive);
    const dealt = Math.min(target.health, remaining);
    target.health -= dealt;
    remaining -= dealt;
    const killed = target.health === 0;
    if (killed) target.status = "ko";
    const existing = hits.find((hit) => hit.enemy.id === target.id);
    if (existing) {
      existing.damage += dealt;
      existing.killed = existing.killed || killed;
    } else {
      hits.push({ enemy: target, damage: dealt, killed });
    }
  }
  return hits;
}

/** Mayor amenaza viva: primero quien sostiene el campo, luego el más débil. */
export function threatTarget(alive: EnemyCombatant[]): EnemyCombatant {
  const priority: EnemyRole[] = ["support", "mage", "captain", "ranged", "assassin", "disruptor", "berserker", "drain", "breaker", "tank"];
  const ranked = alive
    .slice()
    .sort((a, b) => priority.indexOf(a.role) - priority.indexOf(b.role) || a.health - b.health);
  return ranked[0];
}
