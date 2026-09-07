import { rm } from "node:fs/promises";
import type { IdentityStore } from "./identity-store.js";
import type { PlayerId } from "./players.js";
import type { RealmState } from "./domain.js";
import type { RealmStore } from "./realm-store.js";

/**
 * LLEVARSE LO SUYO Y BORRARLO (etapa 7).
 *
 * Play Store lo exige, y con razón: un jugador tiene derecho a llevarse su
 * expediente y a que no quede nada suyo. Hasta E2 esto era imposible de
 * cumplir con verdad, porque no había forma de saber qué era de quién.
 *
 * ESTO NO CONTRADICE EL ARTÍCULO 3 («anular no es borrar»). Ese artículo
 * protege la historia DENTRO de una partida: que un hecho registrado no se
 * pueda reescribir para que la campaña parezca otra cosa. El derecho al olvido
 * es lo contrario y va sobre la partida entera: el jugador se lleva su reino y
 * deja de existir aquí. Un expediente al que no se puede renunciar no es un
 * expediente, es un archivo policial.
 */

export interface PlayerExport {
  exportedAt: string;
  playerId: PlayerId;
  realm: RealmState;
  agents: Array<{ id: string; label: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt?: string }>;
}

export async function exportPlayer(
  store: RealmStore,
  identity: IdentityStore,
  playerId: PlayerId,
  exportedAt: string,
): Promise<PlayerExport> {
  const realm = await store.read(playerId);
  const state = await identity.read();
  return {
    exportedAt,
    playerId,
    // El reino entero, tal cual: es suyo.
    realm,
    // Los agentes, sin sus llaves: no se exporta lo que ni siquiera guardamos.
    agents: state.grants
      .filter((grant) => grant.playerId === playerId)
      .map((grant) => ({
        id: grant.id,
        label: grant.label,
        scopes: grant.scopes,
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        revokedAt: grant.revokedAt,
      })),
  };
}

export interface ForgetOutcome {
  playerId: PlayerId;
  artifactsRemoved: number;
  sessionsRemoved: number;
  grantsRemoved: number;
  realmRemoved: boolean;
}

/**
 * BORRAR DE VERDAD.
 *
 * En este orden: primero los archivos que el jugador entregó, porque su
 * ubicación sólo se conoce desde el reino; después el reino; y al final la
 * identidad, para que si algo falla a mitad el jugador siga pudiendo entrar y
 * repetirlo, en vez de quedarse con un reino huérfano y sin llave.
 */
export async function forgetPlayer(
  store: RealmStore,
  identity: IdentityStore,
  playerId: PlayerId,
): Promise<ForgetOutcome> {
  const realm = await store.read(playerId);

  let artifactsRemoved = 0;
  for (const artifact of realm.artifacts ?? []) {
    if (!artifact.storedPath) continue;
    try {
      await rm(artifact.storedPath, { force: true });
      artifactsRemoved += 1;
    } catch {
      // Un archivo que ya no está es exactamente el resultado buscado.
    }
  }

  const realmRemoved = typeof store.forget === "function" ? await store.forget(playerId) : false;

  const { sessions, grants } = await identity.mutate((state) => {
    const sessionsAntes = state.sessions.length;
    const grantsAntes = state.grants.length;
    state.sessions = state.sessions.filter((session) => session.playerId !== playerId);
    state.grants = state.grants.filter((grant) => grant.playerId !== playerId);
    state.players = state.players.filter((player) => player.playerId !== playerId);
    return { sessions: sessionsAntes - state.sessions.length, grants: grantsAntes - state.grants.length };
  });

  return { playerId, artifactsRemoved, sessionsRemoved: sessions, grantsRemoved: grants, realmRemoved };
}
