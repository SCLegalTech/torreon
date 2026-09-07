import express, { type Request, type Response, type Router } from "express";
import { systemClock, type Clock } from "./clock.js";
import { HTTP_BODIES, type HttpRoute } from "./contracts.js";
import { invalid } from "./errors.js";
import { eventsSince } from "./realm-bus.js";
import type { QuestService } from "./quest-service.js";
import { RealmViews, SCHEMA_VERSION, type Envelope } from "./v1-service.js";

/**
 * EL CONTRATO `/v1` — el que consumirá Unity (03-CONTRATO-DE-CLIENTE.md).
 *
 * Tres canales y nada más:
 *
 *   VISTA    GET  /v1/…            «dame la foto de esta pantalla»
 *   EVENTOS  GET  /v1/stream       «avísame cuando algo cambie»
 *   COMANDO  POST /v1/…            «el jugador quiere hacer esto»
 *
 * Lo que NO hay aquí, a propósito: una ruta que devuelva el estado persistido.
 * Eso era `GET /api/state`, y eran 345 MB por hora y cliente conectado.
 *
 * `/api` sigue existiendo para el cliente React mientras migra. Es la superficie
 * legada; lo nuevo entra por aquí.
 */
export function createV1Router(service: QuestService, clock: Clock = systemClock): Router {
  const router = express.Router();
  const views = new RealmViews(service, clock);

  const envelope = <T>(data: T, cursor: string): Envelope<T> => ({
    schemaVersion: SCHEMA_VERSION,
    serverTime: clock.iso(),
    cursor,
    data,
  });

  const read =
    <T>(handler: (req: Request) => Promise<Envelope<T>>): express.RequestHandler =>
    async (req, res, next) => {
      try {
        res.json(await handler(req));
      } catch (error) {
        next(error);
      }
    };

  /** Un comando devuelve SIEMPRE el resultado autoritativo, nunca un 204. */
  const command =
    <T>(route: HttpRoute | null, handler: (req: Request) => Promise<T>): express.RequestHandler[] => {
      const validate: express.RequestHandler = (req, _res, next) => {
        if (!route) return next();
        const parsed = HTTP_BODIES[route].safeParse(req.body ?? {});
        if (!parsed.success) {
          const detalle = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "cuerpo"}: ${issue.message}`)
            .join("; ");
          return next(invalid(`La petición no tiene la forma que esta ruta espera — ${detalle}`));
        }
        req.body = parsed.data;
        next();
      };
      const run: express.RequestHandler = async (req, res, next) => {
        try {
          const data = await handler(req);
          res.json(envelope(data, await views.cursor()));
        } catch (error) {
          next(error);
        }
      };
      return [validate, run];
    };

  // ---------------------------------------------------------------------------
  // VISTAS. Cada pantalla pide lo suyo (artículos 12 y 16).
  // ---------------------------------------------------------------------------
  router.get("/realm/summary", read(() => views.summary()));
  router.get("/map", read(() => views.map()));
  router.get("/battle/:questId", read((req) => views.battle(String(req.params.questId))));
  router.get("/quests/:questId", read((req) => views.quest(String(req.params.questId))));
  router.get("/barracks", read(() => views.barracks()));
  router.get("/treasury", read(() => views.treasury()));
  router.get(
    "/notifications",
    read((req) => {
      const limit = Number(req.query.limit);
      return views.notifications({
        unreadOnly: req.query.unreadOnly === "true" || req.query.unreadOnly === "1",
        limit: Number.isFinite(limit) ? limit : undefined,
        entityType: req.query.entityType ? (String(req.query.entityType) as never) : undefined,
        includeArchived: req.query.includeArchived === "true" || req.query.includeArchived === "1",
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // EVENTOS (SSE). El aviso de que la verdad cambió, no la verdad.
  //
  // Reanudable por `cursor`: el cliente pide la vista, recibe el punto exacto
  // del expediente en que está esa foto, y se suscribe DESDE AHÍ. Sin eso queda
  // una ventana en la que un hecho se pierde entre la foto y la suscripción.
  // ---------------------------------------------------------------------------
  router.get("/stream", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let lastCursor = req.query.since ? String(req.query.since) : "";

    const send = (event: { id: string; type: string; createdAt?: string }, source: "realm" | "game") => {
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${source}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Lo ocurrido desde el cursor, antes de escuchar lo nuevo: así no hay hueco.
    try {
      const state = await service.tick();
      for (const event of eventsSince(state.events ?? [], lastCursor)) send(event, "realm");
      lastCursor = state.events?.[0]?.id ?? lastCursor;
    } catch {
      // Si el reino no se puede leer ahora, la suscripción sigue viva: el
      // siguiente aviso traerá la verdad.
    }

    const unsubscribe = service.bus.subscribe(service.playerIdOfRealm, (tick) => {
      for (const event of eventsSince(tick.events, lastCursor)) send(event, "realm");
      if (tick.cursor) lastCursor = tick.cursor;
    });

    // Un latido cada 25 s: los proxies cortan una conexión callada.
    const heartbeat = setInterval(() => res.write(": latido\n\n"), 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  // ---------------------------------------------------------------------------
  // COMANDOS. El jugador quiere hacer algo; el Núcleo decide si puede.
  // ---------------------------------------------------------------------------
  router.post(
    "/quests/from-intent",
    ...command("POST /api/quests/from-intent", (req) =>
      service.createDraftFromIntent(req.body.intent, req.body.minutesAvailable, req.body.actId, req.body.campaignId),
    ),
  );
  router.post(
    "/quests/:questId/accept",
    ...command("POST /api/quests/:questId/accept", (req) => service.accept(String(req.params.questId), req.body.userAccepted === true)),
  );
  router.post(
    "/quests/:questId/start",
    ...command("POST /api/quests/:questId/start", (req) => service.start(String(req.params.questId), req.body.durationMinutes)),
  );
  router.post(
    "/quests/:questId/discard",
    ...command("POST /api/quests/:questId/discard", (req) => service.discardQuest(String(req.params.questId), String(req.body.reason ?? ""))),
  );
  router.post(
    "/quests/:questId/battle/retry",
    ...command("POST /api/quests/:questId/battle/retry", (req) => service.retryBattle(String(req.params.questId), req.body.durationMinutes)),
  );
  router.post("/quests/:questId/battle/recover", ...command(null, (req) => service.recoverParty(String(req.params.questId))));
  router.post(
    "/quests/:questId/battle/recontract",
    ...command("POST /api/quests/:questId/battle/recontract", (req) =>
      service.proposeBattleRecontract(String(req.params.questId), {
        reason: req.body.reason,
        newDurationMinutes: req.body.newDurationMinutes,
      }),
    ),
  );
  router.post(
    "/quests/:questId/battle/recontract/accept",
    ...command("POST /api/quests/:questId/battle/recontract/accept", (req) =>
      service.acceptBattleRecontract(String(req.params.questId), req.body.recontractId, req.body.userAccepted === true),
    ),
  );
  router.post(
    "/quests/:questId/steps/:stepId/artifacts",
    ...command("POST /api/quests/:questId/steps/:stepId/artifacts", (req) =>
      service.attachArtifact(String(req.params.questId), String(req.params.stepId), {
        kind: req.body.kind ?? "text",
        path: req.body.path,
        url: req.body.url,
        text: req.body.text,
        label: req.body.label,
        dataBase64: req.body.dataBase64,
        filename: req.body.filename,
        mimeType: req.body.mimeType,
      }),
    ),
  );
  router.post(
    "/quests/:questId/steps/:stepId/verify",
    ...command("POST /api/quests/:questId/steps/:stepId/verify", (req) =>
      service.verifyStep(String(req.params.questId), String(req.params.stepId), {
        note: req.body.note,
        artifactIds: req.body.artifactIds,
      }),
    ),
  );
  router.post(
    "/quests/:questId/steps/:stepId/evidence",
    ...command("POST /api/quests/:questId/steps/:stepId/evidence", (req) =>
      service.submitEvidence(String(req.params.questId), String(req.params.stepId), {
        summary: req.body.summary,
        source: req.body.source ?? "user_declaration",
        verdict: req.body.verdict,
        reasoning: req.body.reasoning,
        impactAwarded: req.body.impactAwarded,
      }),
    ),
  );
  router.post(
    "/inventory/use",
    ...command("POST /api/inventory/use", (req) => service.useInventoryItem(req.body.itemId, req.body.target, req.body.questId)),
  );
  router.post("/quests/:questId/focus", ...command(null, (req) => service.focusQuest(String(req.params.questId)).then(() => ({ focused: req.params.questId }))));
  router.delete("/quests/focus", ...command(null, () => service.focusQuest(null).then(() => ({ focused: null }))));
  router.post("/notifications/:id/read", ...command(null, (req) => service.markNotificationRead(String(req.params.id))));
  router.post("/notifications/:id/archive", ...command(null, (req) => service.archiveNotification(String(req.params.id))));
  router.post(
    "/campaigns/:campaignId/accept",
    ...command("POST /api/campaigns/:campaignId/accept", (req) => service.acceptCampaign(String(req.params.campaignId), req.body.userAccepted === true)),
  );
  router.post(
    "/finance/transactions",
    ...command("POST /api/finance/transactions", (req) => service.recordFinancialTransaction(req.body)),
  );

  return router;
}
