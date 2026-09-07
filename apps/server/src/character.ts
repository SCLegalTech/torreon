import { isoAt } from "./clock.js";
import type { PartyMemberId, PlayerSheet, RealmState } from "./domain.js";
import { deny } from "./errors.js";

/**
 * LA FICHA DEL JUGADOR.
 *
 * Hasta ahora el grupo era fijo —Marqués, Cordera y Roku— con nombres
 * cableados. Con varios jugadores en el reino eso deja de servir: cada uno
 * encarna a alguien y le pone nombre a lo suyo.
 *
 * LAS REGLAS, QUE NO SON DE PANTALLA:
 *
 *   - El jugador elige arquetipo. `marques` y `cordera` son los dos que se
 *     pueden encarnar; ese arquetipo lleva SU nombre en el grupo.
 *   - El otro arquetipo sigue en el grupo con su nombre canónico. El grupo son
 *     tres y no se rompe la formación por crear una ficha.
 *   - **Roku es la mascota.** No se encarna: se le pone nombre y punto.
 *   - El id interno NUNCA cambia. `roko` sigue siendo `roko` en toda la
 *     historia persistida; lo que cambia es el nombre que se resuelve al leer.
 *     Renombrar una pantalla no puede romper un evento de hace un mes.
 */

/** Los dos que un jugador puede encarnar. Roku no: Roku es la mascota. */
export const PLAYABLE_ARCHETYPES = ["marques", "cordera"] as const;
export type PlayableArchetype = (typeof PLAYABLE_ARCHETYPES)[number];

export const CANONICAL_NAME: Record<PartyMemberId, string> = {
  roko: "Roku",
  marques: "Marqués",
  cordera: "Cordera",
};

export const CANONICAL_TITLE: Record<PlayableArchetype, string> = {
  marques: "Guardián de la Marca",
  cordera: "Guardiana de la Marca",
};

export interface CharacterInput {
  archetype: PlayableArchetype;
  /** Cómo se llama el personaje del jugador. */
  displayName: string;
  /** Cómo se llama la mascota. Si no se dice, Roku sigue siendo Roku. */
  petName?: string;
  title?: string;
}

function limpio(valor: string, maximo: number): string {
  return valor.trim().replace(/\s+/g, " ").slice(0, maximo);
}

export function createCharacter(state: RealmState, input: CharacterInput, nowMs: number): PlayerSheet {
  if (!PLAYABLE_ARCHETYPES.includes(input.archetype)) {
    throw deny("Sólo se pueden encarnar el Marqués o la Cordera. Roku es la mascota.");
  }
  const displayName = limpio(input.displayName ?? "", 40);
  if (displayName.length < 2) throw deny("El personaje necesita un nombre de al menos dos letras.");
  const petName = limpio(input.petName ?? "", 40) || CANONICAL_NAME.roko;

  state.player = {
    displayName,
    title: limpio(input.title ?? "", 60) || CANONICAL_TITLE[input.archetype],
    archetype: input.archetype,
    petName,
    createdAt: state.player.createdAt ?? isoAt(nowMs),
  };
  return state.player;
}

/** `true` si el jugador todavía no ha creado su ficha. La pantalla lo pregunta. */
export function needsCharacter(state: RealmState): boolean {
  return !state.player.createdAt;
}

/**
 * Cómo se llama cada miembro del grupo PARA ESTE JUGADOR.
 *
 * Se resuelve en la lectura, nunca se persiste en el evento: por eso renombrar
 * al personaje no reescribe una sola línea de historia.
 */
export function partyNamesFor(player: PlayerSheet): Record<PartyMemberId, { name: string; role: string }> {
  const archetype = player.archetype ?? "marques";
  const nombreDe = (id: PartyMemberId): string => {
    if (id === "roko") return player.petName?.trim() || CANONICAL_NAME.roko;
    if (id === archetype) return player.displayName?.trim() || CANONICAL_NAME[id];
    return CANONICAL_NAME[id];
  };
  return {
    roko: { name: nombreDe("roko"), role: "Mascota / Guardia" },
    marques: { name: nombreDe("marques"), role: "Explorador / DPS" },
    cordera: { name: nombreDe("cordera"), role: "Sanadora / Apoyo" },
  };
}
