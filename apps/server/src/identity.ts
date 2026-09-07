import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isoAt } from "./clock.js";
import { deny, forbidden, notFound } from "./errors.js";
import { DEFAULT_PLAYER_ID, requirePlayerId, type PlayerId } from "./players.js";

/**
 * DOS IDENTIDADES, NO UNA (artículo 11, ADR-0007).
 *
 * En Torreón los agentes son jugadores de primera clase: ChatGPT, Claude y
 * Codex crean quests, adjuntan evidencia y emiten veredictos por MCP. Eso no es
 * una integración, es una de las dos formas de jugar. Por eso hay dos
 * identidades separadas, con dos ciclos de vida:
 *
 *   SESIÓN DE JUGADOR — entra desde la APK. Puede todo sobre lo suyo.
 *   CONCESIÓN DE AGENTE — actúa EN NOMBRE DE un jugador, con alcance declarado,
 *   y se revoca sola, sin cerrarle la sesión al jugador.
 *
 * Lo que NO es esto: un token compartido. `TORREON_API_TOKEN` cierra la puerta
 * pero no dice quién llama, no se revoca por jugador y no sobrevive a la
 * publicación. Es un tapón; esto es la identidad.
 *
 * Ningún secreto se guarda en claro: sólo su huella. Un volcado del reino no
 * entrega la llave de nadie.
 */

export type Scope = "realm:read" | "realm:write" | "quest:write" | "evidence:write";

export const ALL_SCOPES: Scope[] = ["realm:read", "realm:write", "quest:write", "evidence:write"];

/** Lo que un agente necesita para jugar de verdad. Nunca administrar. */
export const AGENT_DEFAULT_SCOPES: Scope[] = ["realm:read", "quest:write", "evidence:write"];

export interface PlayerRecord {
  playerId: PlayerId;
  displayName: string;
  createdAt: string;
  /** Huella de la llave del dispositivo que estrenó este jugador. */
  deviceKeyHash: string;
}

export interface SessionRecord {
  id: string;
  playerId: PlayerId;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface AgentGrantRecord {
  id: string;
  playerId: PlayerId;
  /** Quién es este agente, en palabras del jugador: «ChatGPT del portátil». */
  label: string;
  tokenHash: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt?: string;
  revokedReason?: string;
}

export interface IdentityState {
  version: 1;
  players: PlayerRecord[];
  sessions: SessionRecord[];
  grants: AgentGrantRecord[];
}

export const emptyIdentity = (): IdentityState => ({ version: 1, players: [], sessions: [], grants: [] });

/** Treinta días. Una sesión de juego no debería caducar en mitad de una Battle. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Comparación en tiempo constante: un secreto no se compara con `===`. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function mintToken(prefix: "tor_s" | "tor_a"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/**
 * ENTRAR DESDE EL TELÉFONO.
 *
 * La primera vez, la llave del dispositivo estrena jugador y reino. Las
 * siguientes, la misma llave devuelve al MISMO jugador: reinstalar la app no
 * puede fabricar un reino nuevo y perder la campaña.
 *
 * Es una cuenta anónima de dispositivo a propósito: el jugador juega antes de
 * dar ningún dato. Vincularla a una cuenta real después es aditivo.
 */
export function openDeviceSession(
  identity: IdentityState,
  input: { deviceKey: string; displayName?: string },
  nowMs: number,
): { player: PlayerRecord; token: string; session: SessionRecord } {
  if (!input.deviceKey || input.deviceKey.trim().length < 16) {
    throw deny("La llave del dispositivo necesita al menos 16 caracteres.");
  }
  const deviceKeyHash = hash(input.deviceKey.trim());
  const timestamp = isoAt(nowMs);

  let player = identity.players.find((candidate) => sameSecret(candidate.deviceKeyHash, deviceKeyHash));
  if (!player) {
    player = {
      // El primer jugador adopta el reino que ya existía; los demás estrenan.
      playerId: identity.players.length === 0 ? DEFAULT_PLAYER_ID : requirePlayerId(`jugador-${randomUUID().slice(0, 8)}`),
      displayName: input.displayName?.trim().slice(0, 80) || "Marqués Phi",
      createdAt: timestamp,
      deviceKeyHash,
    };
    identity.players.push(player);
  }

  const token = mintToken("tor_s");
  const session: SessionRecord = {
    id: randomUUID(),
    playerId: player.playerId,
    tokenHash: hash(token),
    createdAt: timestamp,
    expiresAt: isoAt(nowMs + SESSION_TTL_MS),
    lastSeenAt: timestamp,
  };
  identity.sessions.unshift(session);
  // Una sesión caducada o revocada ya no dice nada de nadie: se olvida.
  identity.sessions = identity.sessions.filter(
    (candidate) => !candidate.revokedAt && Date.parse(candidate.expiresAt) > nowMs,
  );
  return { player, token, session };
}

export interface Caller {
  playerId: PlayerId;
  via: "session" | "agent";
  scopes: Scope[];
  /** Sólo para agentes: qué concesión está actuando, para poder auditarla. */
  grantId?: string;
}

/** Quién llama. `null` si el secreto no vale, caducó o fue revocado. */
export function resolveCaller(identity: IdentityState, token: string | undefined, nowMs: number): Caller | null {
  if (!token) return null;
  const digest = hash(token);

  const session = identity.sessions.find((candidate) => sameSecret(candidate.tokenHash, digest));
  if (session) {
    if (session.revokedAt || Date.parse(session.expiresAt) <= nowMs) return null;
    session.lastSeenAt = isoAt(nowMs);
    return { playerId: session.playerId, via: "session", scopes: ALL_SCOPES };
  }

  const grant = identity.grants.find((candidate) => sameSecret(candidate.tokenHash, digest));
  if (grant) {
    if (grant.revokedAt) return null;
    grant.lastUsedAt = isoAt(nowMs);
    return { playerId: grant.playerId, via: "agent", scopes: grant.scopes, grantId: grant.id };
  }

  return null;
}

/**
 * CONCEDER ACCESO A UN AGENTE.
 *
 * El jugador declara a quién y para qué. El secreto se muestra UNA vez: aquí no
 * se guarda en claro, así que no se puede volver a enseñar.
 */
export function grantAgent(
  identity: IdentityState,
  input: { playerId: PlayerId; label: string; scopes?: Scope[] },
  nowMs: number,
): { grant: AgentGrantRecord; token: string } {
  if (input.label.trim().length < 2) throw deny("La concesión necesita un nombre que el jugador reconozca.");
  const scopes = (input.scopes ?? AGENT_DEFAULT_SCOPES).filter((scope) => ALL_SCOPES.includes(scope));
  if (scopes.length === 0) throw deny("Una concesión sin alcance no sirve para nada.");
  const token = mintToken("tor_a");
  const grant: AgentGrantRecord = {
    id: randomUUID(),
    playerId: input.playerId,
    label: input.label.trim().slice(0, 80),
    tokenHash: hash(token),
    scopes,
    createdAt: isoAt(nowMs),
    lastUsedAt: null,
  };
  identity.grants.unshift(grant);
  return { grant, token };
}

/** Cortar a un agente NO cierra la sesión del jugador. Ese es el punto. */
export function revokeAgent(identity: IdentityState, playerId: PlayerId, grantId: string, reason: string, nowMs: number): AgentGrantRecord {
  const grant = identity.grants.find((candidate) => candidate.id === grantId);
  if (!grant) throw notFound(`Concesión no encontrada: ${grantId}`);
  if (grant.playerId !== playerId) throw forbidden("Esa concesión no es tuya.");
  if (grant.revokedAt) return grant;
  grant.revokedAt = isoAt(nowMs);
  grant.revokedReason = reason.trim().slice(0, 200) || "revocada por el jugador";
  return grant;
}

/** Lo que el jugador ve en su pantalla de agentes. Sin secretos, obviamente. */
export interface AgentGrantView {
  id: string;
  label: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt?: string;
  /** `true` si este agente llegó a actuar alguna vez. Conceder no es actuar. */
  used: boolean;
}

export function agentsOf(identity: IdentityState, playerId: PlayerId): AgentGrantView[] {
  return identity.grants
    .filter((grant) => grant.playerId === playerId)
    .map((grant) => ({
      id: grant.id,
      label: grant.label,
      scopes: grant.scopes,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      revokedAt: grant.revokedAt,
      used: grant.lastUsedAt !== null,
    }));
}

/** Cerrar la sesión de este dispositivo. No toca a los agentes concedidos. */
export function closeSession(identity: IdentityState, token: string, nowMs: number): boolean {
  const digest = hash(token);
  const session = identity.sessions.find((candidate) => sameSecret(candidate.tokenHash, digest));
  if (!session || session.revokedAt) return false;
  session.revokedAt = isoAt(nowMs);
  return true;
}

export function requireScope(caller: Caller, scope: Scope): void {
  if (!caller.scopes.includes(scope)) {
    throw forbidden(`Esta credencial no alcanza para «${scope}».`);
  }
}
