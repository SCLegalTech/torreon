import type express from "express";
import type { Clock } from "./clock.js";
import { forbidden } from "./errors.js";
import type { IdentityStore } from "./identity-store.js";
import { resolveCaller, type Caller } from "./identity.js";
import { DEFAULT_PLAYER_ID } from "./players.js";

/**
 * QUIÉN PREGUNTA (artículo 11, ADR-0007).
 *
 * `TORREON_IDENTITY=on` enciende la identidad de verdad. Apagada —el valor por
 * defecto— todo el mundo es el jugador de siempre y nada cambia: encender la
 * identidad en un reino que ya está jugando es una decisión de persona, no el
 * efecto secundario de un despliegue.
 *
 * Encendida, ninguna ruta de juego responde sin credencial, y la credencial
 * decide QUÉ REINO se toca. Un jugador nunca alcanza el reino de otro porque el
 * servicio se elige por él, no por lo que pida.
 */
export const identityEnabled = (raw = process.env.TORREON_IDENTITY): boolean => raw?.trim().toLowerCase() === "on";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

export function bearerOf(req: express.Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

/**
 * Resuelve al llamante y lo deja en la petición.
 *
 * Con la identidad apagada, todo el mundo es el jugador por defecto con todos
 * los alcances: es exactamente lo que pasaba antes de que existiera esto.
 */
export function callerMiddleware(identity: IdentityStore, clock: Clock): express.RequestHandler {
  return async (req, _res, next) => {
    if (!identityEnabled()) {
      req.caller = { playerId: DEFAULT_PLAYER_ID, via: "session", scopes: ["realm:read", "realm:write", "quest:write", "evidence:write"] };
      return next();
    }
    try {
      const token = bearerOf(req);
      // La lectura muta `lastSeenAt`/`lastUsedAt`: la atribución de un agente
      // tiene que ser cierta, no una cadena que el llamante rellena.
      const caller = await identity.mutate((state) => resolveCaller(state, token, clock.now()));
      if (caller) req.caller = caller;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Puerta de las rutas de juego. Sin credencial válida no se juega. */
export const requireCaller: express.RequestHandler = (req, _res, next) => {
  if (!req.caller) return next(forbidden("Este reino exige identificarse. Abre sesión desde tu Torreón."));
  next();
};
