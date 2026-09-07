import express, { type Router } from "express";
import { z } from "zod";
import { bearerOf, requireCaller } from "./auth.js";
import { invalid } from "./errors.js";
import { agentsOf, closeSession, grantAgent, nameAvailable, openDeviceSession, registerPlayer, revokeAgent, ALL_SCOPES, type Scope } from "./identity.js";
import type { Kingdom } from "./kingdom.js";
import { exportPlayer, forgetPlayer } from "./player-data.js";

/**
 * LAS PUERTAS DE LA IDENTIDAD (artículo 11, ADR-0007).
 *
 *   POST   /v1/session/device   entrar desde este teléfono
 *   DELETE /v1/session          cerrar esta sesión (no toca a los agentes)
 *   GET    /v1/agents           qué agentes tienen acceso y qué han hecho
 *   POST   /v1/agents           conceder acceso a un agente
 *   DELETE /v1/agents/:id       cortarlo, sin cerrar la sesión del jugador
 *
 * Un secreto se enseña UNA vez, al crearlo. El servidor sólo guarda su huella,
 * así que no puede volver a enseñarlo ni aunque quisiera.
 */
const deviceBody = z.object({
  deviceKey: z.string().min(16).max(512),
  displayName: z.string().min(1).max(80).optional(),
});

const grantBody = z.object({
  label: z.string().min(2).max(80),
  scopes: z.array(z.enum(ALL_SCOPES as [Scope, ...Scope[]])).min(1).max(ALL_SCOPES.length).optional(),
});

const revokeBody = z.object({ reason: z.string().max(200).optional() });

const registerBody = z.object({
  deviceKey: z.string().min(16).max(512),
  displayName: z.string().min(2).max(40),
  archetype: z.enum(["marques", "cordera"]),
  petName: z.string().min(1).max(40).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const detalle = parsed.error.issues.map((issue) => `${issue.path.join(".") || "cuerpo"}: ${issue.message}`).join("; ");
  throw invalid(`La petición no tiene la forma que esta ruta espera — ${detalle}`);
}

export function createIdentityRouter(kingdom: Kingdom): Router {
  const router = express.Router();
  const clock = kingdom.realmClock;

  /**
   * ENTRAR. La primera vez estrena jugador y reino; las siguientes devuelve al
   * MISMO: reinstalar la app no puede fabricar un reino nuevo y perder la
   * campaña.
   */
  router.post("/session/device", async (req, res, next) => {
    try {
      const body = parse(deviceBody, req.body);
      const outcome = await kingdom.identity.mutate((identity) => openDeviceSession(identity, body, clock.now()));
      // El reino del jugador se estrena aquí, no en su primera partida.
      await kingdom.realmOf(outcome.player.playerId).snapshot();
      res.status(201).json({
        playerId: outcome.player.playerId,
        displayName: outcome.player.displayName,
        // Se enseña UNA vez. El servidor guarda la huella, no la llave.
        token: outcome.token,
        expiresAt: outcome.session.expiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * REGISTRARSE EN LA BETA CERRADA.
   *
   * El nombre es único en el reino. Quien reclame el nombre heredado recupera
   * la partida que ya existía —campañas, frentes, expediente— en vez de
   * estrenar un reino vacío; se reclama UNA vez.
   *
   * La ficha se crea en el mismo paso: registrarse y no saber a quién encarnas
   * dejaría al jugador a medio entrar.
   */
  router.post("/session/register", async (req, res, next) => {
    try {
      const body = parse(registerBody, req.body);
      const outcome = await kingdom.identity.mutate((identity) =>
        registerPlayer(identity, { deviceKey: body.deviceKey, displayName: body.displayName }, clock.now()),
      );
      const player = await kingdom
        .realmOf(outcome.player.playerId)
        .createCharacter({ archetype: body.archetype, displayName: body.displayName, petName: body.petName });
      res.status(201).json({
        playerId: outcome.player.playerId,
        player,
        token: outcome.token,
        expiresAt: outcome.session.expiresAt,
        // `true` si este registro recuperó la partida que ya existía.
        claimedLegacyRealm: outcome.claimedLegacyRealm,
      });
    } catch (error) {
      next(error);
    }
  });

  /** ¿Está libre este nombre? La pantalla lo pregunta antes de dejar seguir. */
  router.get("/session/name-available", async (req, res, next) => {
    try {
      const identity = await kingdom.identity.read();
      res.json({ available: nameAvailable(identity, String(req.query.name ?? "")) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/session", requireCaller, async (req, res, next) => {
    try {
      const token = bearerOf(req);
      const closed = token ? await kingdom.identity.mutate((identity) => closeSession(identity, token, clock.now())) : false;
      res.json({ closed });
    } catch (error) {
      next(error);
    }
  });

  router.get("/agents", requireCaller, async (req, res, next) => {
    try {
      const identity = await kingdom.identity.read();
      res.json({ agents: agentsOf(identity, req.caller!.playerId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/agents", requireCaller, async (req, res, next) => {
    try {
      const body = parse(grantBody, req.body);
      const outcome = await kingdom.identity.mutate((identity) =>
        grantAgent(identity, { playerId: req.caller!.playerId, label: body.label, scopes: body.scopes }, clock.now()),
      );
      res.status(201).json({
        agent: { id: outcome.grant.id, label: outcome.grant.label, scopes: outcome.grant.scopes },
        // La única vez que esta llave existe fuera de su huella.
        token: outcome.token,
      });
    } catch (error) {
      next(error);
    }
  });

  /** Cortar a un agente NO cierra la sesión del jugador. Ese es el punto. */
  router.delete("/agents/:grantId", requireCaller, async (req, res, next) => {
    try {
      const body = parse(revokeBody, req.body);
      const grant = await kingdom.identity.mutate((identity) =>
        revokeAgent(identity, req.caller!.playerId, String(req.params.grantId), body.reason ?? "", clock.now()),
      );
      res.json({ agent: { id: grant.id, label: grant.label, revokedAt: grant.revokedAt, revokedReason: grant.revokedReason } });
    } catch (error) {
      next(error);
    }
  });

  /**
   * LLEVARSE LO SUYO. Todo el reino, tal cual, más los agentes sin sus llaves.
   */
  router.get("/player/export", requireCaller, async (req, res, next) => {
    try {
      const data = await exportPlayer(kingdom.store, kingdom.identity, req.caller!.playerId, clock.iso());
      res.setHeader("Content-Disposition", `attachment; filename="torreon-${req.caller!.playerId}.json"`);
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  /**
   * DEJAR DE EXISTIR AQUÍ. Play Store lo exige y es lo correcto: un expediente
   * al que no se puede renunciar no es un expediente.
   */
  router.delete("/player", requireCaller, async (req, res, next) => {
    try {
      const confirmacion = parse(z.object({ confirm: z.literal("borrar mi reino") }), req.body);
      void confirmacion;
      res.json(await forgetPlayer(kingdom.store, kingdom.identity, req.caller!.playerId));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
