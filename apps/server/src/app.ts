import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { demoQuest, QuestService } from "./quest-service.js";
import { describeFailure, invalid } from "./errors.js";
import { HTTP_BODIES, type HttpRoute } from "./contracts.js";
import { createV1Router } from "./v1.js";
import { callerMiddleware, identityEnabled, requireCaller } from "./auth.js";
import { createIdentityRouter } from "./identity-routes.js";
import type { Kingdom } from "./kingdom.js";
import { DEFAULT_PLAYER_ID } from "./players.js";

/**
 * El transporte HTTP.
 *
 * Con un `Kingdom` delante, cada petición toca el reino de QUIEN llama
 * (artículos 10 y 11). Sin él —el modo de siempre, y el de casi todas las
 * pruebas— hay un solo reino y todo el mundo es su dueño.
 */
export function createHttpApp(service: QuestService, kingdom?: Kingdom) {
  const app = express();
  app.disable("x-powered-by");

  /** Con la identidad apagada nadie tiene que identificarse. Es lo de siempre. */
  const requireCallerUnlessOpen: express.RequestHandler = (req, res, next) =>
    identityEnabled() ? requireCaller(req, res, next) : next();
  // Con `TORREON_ALLOWED_ORIGINS` la respuesta se acota a los orígenes
  // declarados. Sin ella sigue abierto: la APK de Capacitor no sirve desde este
  // dominio y cerrarlo a ciegas la dejaría fuera de su propio reino. La
  // protección real de la API es la llave, no el origen.
  const allowedOrigins = (process.env.TORREON_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (allowedOrigins.length === 0) res.setHeader("Access-Control-Allow-Origin", "*");
    else if (origin && allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    if (allowedOrigins.length > 0) res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    next();
  });
  app.options("*splat", (_req, res) => res.sendStatus(204));
  // Las capturas y documentos del jugador llegan en base64 dentro del cuerpo.
  app.use(express.json({ limit: "32mb" }));

  // ---------------------------------------------------------------------------
  // LA LLAVE DEL REINO.
  //
  // Un tapón, no una identidad. Con `TORREON_API_TOKEN` definido, ninguna ruta
  // de `/api` responde sin `Authorization: Bearer <token>`; sin él, el servidor
  // local sigue abierto en loopback como siempre.
  //
  // ESTO NO ES EL ARTÍCULO 11 y no debe confundirse con él: un secreto
  // compartido no dice QUIÉN llama, no se revoca por jugador y no sobrevive a
  // la publicación. Sirve para que un reino en la nube deje de estar abierto al
  // mundo mientras llega la identidad de verdad (ADR-0007).
  // ---------------------------------------------------------------------------
  const laLlave: express.RequestHandler = (req, res, next) => {
    const expected = process.env.TORREON_API_TOKEN?.trim();
    if (!expected) return next();
    if (req.header("authorization") === `Bearer ${expected}`) return next();
    res.status(401).json({ error: "Este reino está cerrado con llave." });
  };
  app.use("/api", laLlave);
  app.use("/v1", laLlave);

  // EL CONTRATO NUEVO. `/api` es la superficie legada del cliente React.
  const reinoDe = (req: Request): QuestService =>
    kingdom ? kingdom.realmOf(req.caller?.playerId ?? DEFAULT_PLAYER_ID) : service;

  if (kingdom) {
    // Antes que nada: quién pregunta. También en `/mcp`, donde entran agentes.
    app.use(callerMiddleware(kingdom.identity, kingdom.realmClock));
    app.use("/v1", createIdentityRouter(kingdom));
    app.use("/v1", requireCallerUnlessOpen);
  }

  app.use("/v1", createV1Router(reinoDe, service.realmClock, kingdom));

  // ---------------------------------------------------------------------------
  // VALIDACIÓN EN EL BORDE (artículo 7).
  //
  // El mismo contrato que ya defendía MCP, aplicado a HTTP: una petición mal
  // formada se rechaza aquí, con 422 y diciendo QUÉ campo, en vez de convertirse
  // en un error incomprensible tres capas más adentro. Las reglas del reino
  // siguen siendo del Núcleo: esto sólo comprueba la forma.
  // ---------------------------------------------------------------------------
  const validate =
    <P = Record<string, string>>(route: HttpRoute): express.RequestHandler<P> =>
    (req, _res, next) => {
      const parsed = HTTP_BODIES[route].safeParse(req.body ?? {});
      if (parsed.success) {
        req.body = parsed.data;
        next();
        return;
      }
      const detalle = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "cuerpo"}: ${issue.message}`)
        .join("; ");
      next(invalid(`La petición no tiene la forma que esta ruta espera — ${detalle}`));
    };

  app.get("/health", async (_req, res) => {
    const snapshot = await service.snapshot();
    res.json({
      status: "ok",
      server: "torreon",
      version: "0.1.0",
      codice: service.codiceName,
      instance: snapshot.consistency.instance,
      realmId: snapshot.consistency.realmId,
      updatedAt: snapshot.realm.updatedAt,
    });
  });

  app.get("/api/state", async (_req, res, next) => {
    try {
      res.json(await service.snapshot());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quests/:questId", async (req, res, next) => {
    try {
      res.json({ quest: await service.questDetail(req.params.questId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/demo/quest", async (_req, res, next) => {
    try {
      const snapshot = await service.snapshot();
      if (snapshot.currentQuest && !["completed", "abandoned"].includes(snapshot.currentQuest.status)) {
        res.json({ quest: snapshot.currentQuest, reused: true });
        return;
      }
      res.status(201).json({ quest: await service.createDraft(demoQuest), reused: false });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/from-intent", validate("POST /api/quests/from-intent"), async (req, res, next) => {
    try {
      const snapshot = await service.snapshot();
      if (snapshot.currentQuest && !["completed", "abandoned"].includes(snapshot.currentQuest.status)) {
        res.json({ quest: snapshot.currentQuest, reused: true });
        return;
      }
      const minutes = Number(req.body?.minutesAvailable);
      res.status(201).json({
        quest: await service.createDraftFromIntent(
          String(req.body?.intent ?? ""),
          Number.isFinite(minutes) ? minutes : undefined,
          req.body?.actId ? String(req.body.actId) : undefined,
          req.body?.campaignId ? String(req.body.campaignId) : undefined,
        ),
        reused: false,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/accept", validate("POST /api/quests/:questId/accept"), async (req, res, next) => {
    try {
      res.json({ quest: await service.accept(req.params.questId, req.body?.userAccepted === true) });
    } catch (error) {
      next(error);
    }
  });

  // El reloj arranca aquí y sólo aquí: nunca al redactar ni al aceptar.
  app.post("/api/quests/:questId/start", validate("POST /api/quests/:questId/start"), async (req, res, next) => {
    try {
      const minutes = Number(req.body?.durationMinutes);
      res.json({ quest: await service.start(req.params.questId, Number.isFinite(minutes) ? minutes : undefined) });
    } catch (error) {
      next(error);
    }
  });

  // El zurrón: el Core valida y decrementa; el cliente nunca resta por su cuenta.
  app.get("/api/inventory", async (_req, res, next) => {
    try {
      res.json({ inventory: (await service.snapshot()).inventory });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/inventory/use", validate("POST /api/inventory/use"), async (req, res, next) => {
    try {
      // El frente se nombra: con dos Battles esperando auxilio, adivinar
      // significaba gastar el Tónico en la que no era.
      const questId = req.body?.questId ? String(req.body.questId) : undefined;
      res.json(await service.useInventoryItem(req.body?.itemId, req.body?.target, questId));
    } catch (error) {
      next(error);
    }
  });

  // RETIRADA TÁCTICA: la última ruta legal cuando ya no queda ninguna dentro.
  // No concede progreso, no crea evidencia, no devuelve objetos y no revive
  // dentro del intento: lo cierra y deja al grupo con el mínimo de reentrada.
  // ELIMINAR: la misión deja de estar entre los asuntos pendientes y deja de
  // generar avisos. El Core decide si eso es borrar un borrador virgen o
  // abandonar una Quest con historia; la pantalla sólo ofrece la decisión.
  app.post("/api/quests/:questId/discard", validate("POST /api/quests/:questId/discard"), async (req, res, next) => {
    try {
      res.json(await service.discardQuest(req.params.questId, String(req.body?.reason ?? "")));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/battle/recover", async (req, res, next) => {
    try {
      res.json(await service.recoverParty(req.params.questId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quests/:questId/battle/recovery", async (req, res, next) => {
    try {
      res.json({ recovery: await service.recoveryOffer(req.params.questId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/battle/recontract", validate("POST /api/quests/:questId/battle/recontract"), async (req, res, next) => {
    try {
      res.json({
        battle: await service.proposeBattleRecontract(req.params.questId, {
          reason: String(req.body?.reason ?? ""),
          newDurationMinutes: Number(req.body?.newDurationMinutes ?? 0),
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/battle/recontract/accept", validate("POST /api/quests/:questId/battle/recontract/accept"), async (req, res, next) => {
    try {
      res.json({
        battle: await service.acceptBattleRecontract(req.params.questId, String(req.body?.recontractId ?? ""), req.body?.userAccepted === true),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/steps/:stepId/companion-assist", validate("POST /api/quests/:questId/steps/:stepId/companion-assist"), async (req, res, next) => {
    try {
      res.status(201).json({
        assist: await service.recordCompanionAssist({
          questId: req.params.questId,
          stepId: req.params.stepId,
          companion: req.body?.companion,
          source: req.body?.source,
          sourceTool: req.body?.sourceTool ? String(req.body.sourceTool) : undefined,
          executionRef: req.body?.executionRef ? String(req.body.executionRef) : undefined,
          contributionSummary: String(req.body?.contributionSummary ?? ""),
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  // Replanificar repacta el tiempo: no resucita a nadie ni cura gratis.
  app.post("/api/quests/:questId/battle/retry", validate("POST /api/quests/:questId/battle/retry"), async (req, res, next) => {
    try {
      const minutes = Number(req.body?.durationMinutes);
      res.json(await service.retryBattle(req.params.questId, Number.isFinite(minutes) ? minutes : undefined));
    } catch (error) {
      next(error);
    }
  });

  // Códice elige la escala; esta lectura no crea nada, sólo propone.
  app.post("/api/scale/classify", validate("POST /api/scale/classify"), async (req, res, next) => {
    try {
      const activeMinutes = Number(req.body?.activeMinutes);
      const externalWaitMinutes = Number(req.body?.externalWaitMinutes);
      const naturalCampaigns = Number(req.body?.naturalCampaigns);
      res.json({
        proposal: service.classifyObjective(String(req.body?.intent ?? ""), {
          activeMinutes: Number.isFinite(activeMinutes) ? activeMinutes : undefined,
          externalWaitMinutes: Number.isFinite(externalWaitMinutes) ? externalWaitMinutes : undefined,
          naturalCampaigns: Number.isFinite(naturalCampaigns) ? naturalCampaigns : undefined,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sagas", async (req, res, next) => {
    try {
      res.status(201).json({
        saga: await service.createSaga({
          title: String(req.body?.title ?? ""),
          summary: req.body?.summary ? String(req.body.summary) : undefined,
          estimatedActiveMinutes: Number(req.body?.estimatedActiveMinutes ?? 0),
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  // La campaña nace en borrador: no vive hasta que el jugador la sella.
  app.post("/api/campaigns", async (req, res, next) => {
    try {
      res.status(201).json(
        await service.createCampaignDraft({
          title: String(req.body?.title ?? ""),
          intent: req.body?.intent ? String(req.body.intent) : undefined,
          summary: req.body?.summary ? String(req.body.summary) : undefined,
          objective: req.body?.objective ? String(req.body.objective) : undefined,
          rationale: req.body?.rationale ? String(req.body.rationale) : undefined,
          sagaId: req.body?.sagaId ? String(req.body.sagaId) : undefined,
          estimatedActiveMinutes: Number(req.body?.estimatedActiveMinutes ?? 0),
          estimatedCalendarDays: req.body?.estimatedCalendarDays !== undefined ? Number(req.body.estimatedCalendarDays) : undefined,
          scenario: req.body?.scenario ? String(req.body.scenario) : undefined,
          bossTitle: req.body?.bossTitle ? String(req.body.bossTitle) : undefined,
          bossDescription: req.body?.bossDescription ? String(req.body.bossDescription) : undefined,
          initialActs: Array.isArray(req.body?.initialActs) ? req.body.initialActs : undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/campaigns/:campaignId/revise", async (req, res, next) => {
    try {
      res.json(await service.reviseCampaignDraft(req.params.campaignId, req.body ?? {}));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/campaigns/:campaignId/accept", validate("POST /api/campaigns/:campaignId/accept"), async (req, res, next) => {
    try {
      res.json({ campaign: await service.acceptCampaign(req.params.campaignId, req.body?.userAccepted === true) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/campaigns/:campaignId/abandon", async (req, res, next) => {
    try {
      res.json({ campaign: await service.abandonCampaign(req.params.campaignId, String(req.body?.reason ?? "")) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/campaigns/from-intent", async (req, res, next) => {
    try {
      const activeMinutes = Number(req.body?.activeMinutes);
      const calendarDays = Number(req.body?.calendarDays);
      res.status(201).json(
        await service.planCampaignFromIntent({
          intent: String(req.body?.intent ?? ""),
          activeMinutes: Number.isFinite(activeMinutes) ? activeMinutes : undefined,
          calendarDays: Number.isFinite(calendarDays) ? calendarDays : undefined,
          fronts: Array.isArray(req.body?.fronts) ? req.body.fronts.map(String) : undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // Vincula por ID una quest existente; nunca la recrea.
  app.post("/api/quests/:questId/assign", async (req, res, next) => {
    try {
      res.json(
        await service.assignQuest(req.params.questId, {
          campaignId: req.body?.campaignId ? String(req.body.campaignId) : undefined,
          actId: req.body?.actId ? String(req.body.actId) : undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // Cambiar el foco no cierra ninguna otra campaña: sólo mueve la mirada.
  app.post("/api/campaigns/:campaignId/focus", async (req, res, next) => {
    try {
      res.json(await service.focusCampaign(req.params.campaignId));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/campaigns/focus", async (_req, res, next) => {
    try {
      res.json(await service.focusCampaign(null));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/acts", async (req, res, next) => {
    try {
      res.status(201).json({
        act: await service.createAct({
          title: String(req.body?.title ?? ""),
          subtitle: req.body?.subtitle ? String(req.body.subtitle) : undefined,
          outcome: req.body?.outcome ? String(req.body.outcome) : undefined,
          campaignId: req.body?.campaignId ? String(req.body.campaignId) : undefined,
          scenario: req.body?.scenario ? String(req.body.scenario) : undefined,
          estimatedActiveMinutes: Number(req.body?.estimatedActiveMinutes ?? 0),
          dependsOnActIds: Array.isArray(req.body?.dependsOnActIds) ? req.body.dependsOnActIds.map(String) : undefined,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/acts/:actId/quests/:questId", async (req, res, next) => {
    try {
      res.json(await service.assignQuestToAct(req.params.questId, req.params.actId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/amendments", validate("POST /api/quests/:questId/amendments"), async (req, res, next) => {
    try {
      res.status(201).json({ amendment: await service.proposeAmendment(req.params.questId, {
        reason: String(req.body?.reason ?? ""),
        proposedBy: String(req.body?.proposedBy ?? "codice"),
        changes: Array.isArray(req.body?.changes) ? req.body.changes : [],
      }) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/amendments/:amendmentId/accept", validate("POST /api/quests/:questId/amendments/:amendmentId/accept"), async (req, res, next) => {
    try {
      res.json(await service.acceptAmendment(req.params.questId, req.params.amendmentId, req.body?.userAccepted === true));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/steps/:stepId/complete", async (req, res, next) => {
    try {
      res.json(await service.completeStep(req.params.questId, req.params.stepId, String(req.body?.evidenceNote ?? "")));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/steps/:stepId/evidence", validate("POST /api/quests/:questId/steps/:stepId/evidence"), async (req, res, next) => {
    try {
      res.json(await service.submitEvidence(req.params.questId, req.params.stepId, {
        summary: String(req.body?.summary ?? ""),
        source: req.body?.source ?? "user_declaration",
        verdict: req.body?.verdict ?? "rejected",
        reasoning: String(req.body?.reasoning ?? ""),
        impactAwarded: Number(req.body?.impactAwarded ?? 0),
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/steps/:stepId/artifacts", validate("POST /api/quests/:questId/steps/:stepId/artifacts"), async (req, res, next) => {
    try {
      const artifact = await service.attachArtifact(req.params.questId, req.params.stepId, {
        kind: req.body?.kind === "file" || req.body?.kind === "link" ? req.body.kind : "text",
        path: req.body?.path ? String(req.body.path) : undefined,
        url: req.body?.url ? String(req.body.url) : undefined,
        text: req.body?.text ? String(req.body.text) : undefined,
        label: req.body?.label ? String(req.body.label) : undefined,
        dataBase64: req.body?.dataBase64 ? String(req.body.dataBase64) : undefined,
        filename: req.body?.filename ? String(req.body.filename) : undefined,
        mimeType: req.body?.mimeType ? String(req.body.mimeType) : undefined,
      });
      res.status(201).json({ artifact });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/steps/:stepId/artifacts/:artifactId/reuse", async (req, res, next) => {
    try {
      res.json({ artifact: await service.reuseArtifact(req.params.questId, req.params.artifactId, req.params.stepId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/horde-attacks/unexpected-requirement", validate("POST /api/quests/:questId/horde-attacks/unexpected-requirement"), async (req, res, next) => {
    try {
      res.status(201).json(await service.recordUnexpectedRequirement(req.params.questId, {
        stepId: req.body?.stepId ? String(req.body.stepId) : undefined,
        reason: String(req.body?.reason ?? ""),
        damage: Number(req.body?.damage ?? 0),
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/steps/:stepId/verify", validate("POST /api/quests/:questId/steps/:stepId/verify"), async (req, res, next) => {
    try {
      res.json(
        await service.verifyStep(req.params.questId, req.params.stepId, {
          note: req.body?.note ? String(req.body.note) : undefined,
          artifactIds: Array.isArray(req.body?.artifactIds) ? req.body.artifactIds.map(String) : undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // BORRAR EL REINO NO CABE EN LA MISMA LLAVE QUE ABRIRLO.
  //
  // `/api/reset` destruye la campaña entera. Con `TORREON_RESET_TOKEN` exige esa
  // llave aparte; si el reino está cerrado con llave pero nadie declaró una
  // llave de reinicio, la puerta directamente NO existe. Un reino de nube no
  // debe poder vaciarse con la misma credencial con la que se juega.
  app.post("/api/reset", async (req, res, next) => {
    const resetToken = process.env.TORREON_RESET_TOKEN?.trim();
    if (resetToken) {
      if (req.header("x-torreon-reset") !== resetToken) {
        res.status(403).json({ error: "Reiniciar el reino exige su propia llave." });
        return;
      }
    } else if (process.env.TORREON_API_TOKEN?.trim()) {
      res.status(403).json({ error: "Este reino no se puede reiniciar por la API." });
      return;
    }
    try {
      res.json(await service.reset());
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // BARRACAS Y MEMORIA DE BATALLA
  //
  // Sistemas del MUNDO. No cuelgan de Batallas Libres y no son inventario.
  // -------------------------------------------------------------------------
  app.get("/api/barracks", async (_req, res, next) => {
    try {
      res.json({ barracks: await service.barracks() });
    } catch (error) {
      next(error);
    }
  });

  // Disponible no es desplegado: esto declara acceso, nunca participación.
  app.post("/api/barracks/:heroId/availability", validate("POST /api/barracks/:heroId/availability"), async (req, res, next) => {
    try {
      res.json({ barracks: await service.setHeroAvailability(req.params.heroId as never, req.body?.availability) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/battle-memory", async (_req, res, next) => {
    try {
      res.json({ memory: await service.battleMemory() });
    } catch (error) {
      next(error);
    }
  });

  // Sugerencia de planificación. NUNCA repacta un contrato ya aceptado.
  app.post("/api/battle-memory/hint", validate("POST /api/battle-memory/hint"), async (req, res, next) => {
    try {
      res.json({ hint: await service.planningHint(String(req.body?.intent ?? "")) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/quests/:questId/after-action", async (req, res, next) => {
    try {
      res.json({ report: await service.afterActionReport(req.params.questId) });
    } catch (error) {
      next(error);
    }
  });

  // Anular no es borrar: la auditoría conserva el hecho marcado como inválido.
  app.post("/api/events/:eventId/invalidate", validate("POST /api/events/:eventId/invalidate"), async (req, res, next) => {
    try {
      res.json(
        await service.invalidateEvent({
          eventId: req.params.eventId,
          reason: String(req.body?.reason ?? ""),
          invalidatedBy: req.body?.invalidatedBy ? String(req.body.invalidatedBy) : undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // CENTRO DE NOTIFICACIONES. Push es entrega; el registro es la verdad.
  // -------------------------------------------------------------------------
  app.get("/api/notifications", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit);
      res.json(
        await service.getNotifications({
          unreadOnly: req.query.unreadOnly === "true" || req.query.unreadOnly === "1",
          limit: Number.isFinite(limit) ? limit : undefined,
          entityType: req.query.entityType ? (String(req.query.entityType) as never) : undefined,
          // El historial existe: jubilar un aviso no es borrarlo.
          includeArchived: req.query.includeArchived === "true" || req.query.includeArchived === "1",
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/notifications/:id/read", async (req, res, next) => {
    try {
      res.json({ notification: await service.markNotificationRead(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/notifications/:id/archive", async (req, res, next) => {
    try {
      res.json({ notification: await service.archiveNotification(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  // Reenviar sólo abre otro intento de entrega: no recrea nada.
  app.post("/api/notifications/:id/resend", async (req, res, next) => {
    try {
      res.json({ notification: await service.resendNotification(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // FOCO / CICLO DE VIDA DEL BORRADOR. Navegación, no compromiso.
  // -------------------------------------------------------------------------
  app.post("/api/quests/:questId/focus", async (req, res, next) => {
    try {
      res.json(await service.focusQuest(req.params.questId));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/quests/focus", async (_req, res, next) => {
    try {
      res.json(await service.focusQuest(null));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/acts/:actId/focus", async (req, res, next) => {
    try {
      res.json(await service.focusAct(req.params.actId));
    } catch (error) {
      next(error);
    }
  });

  // Sólo un borrador nunca aceptado y sin evidencia validada.
  app.delete("/api/quests/:questId", async (req, res, next) => {
    try {
      res.json(await service.deleteQuestDraft(req.params.questId));
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------------
  // TESORERÍA VIVA. Dinero real en COP; nunca un recurso comprable del juego.
  // -------------------------------------------------------------------------
  app.get("/api/finance/obligations", async (_req, res, next) => {
    try {
      res.json(await service.getFinancialObligations());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/finance/obligations", async (req, res, next) => {
    try {
      res.status(201).json({ obligation: await service.createRecurringObligation(req.body ?? {}) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/finance/obligations/:id", async (req, res, next) => {
    try {
      res.json({ obligation: await service.updateRecurringObligation(req.params.id, req.body ?? {}) });
    } catch (error) {
      next(error);
    }
  });

  // El monto es explícito y obligatorio; nunca se infiere del impacto.
  app.post("/api/finance/transactions", validate("POST /api/finance/transactions"), async (req, res, next) => {
    try {
      res.status(201).json(await service.recordFinancialTransaction(req.body ?? {}));
    } catch (error) {
      next(error);
    }
  });

  // Clientes como ChatGPT solo ofrecen "sin autenticación" o OAuth completo.
  // Para ese caso el endpoint puede montarse en una ruta secreta: la URL actúa
  // como la llave. Es más débil que una cabecera —las URLs se filtran en logs e
  // historiales— pero evita que el MCP quede colgando de un nombre adivinable.
  const mcpPath = process.env.TORREON_MCP_PATH?.trim() || "/mcp";

  app.post(mcpPath, async (req: Request, res: Response) => {
    // Con TORREON_MCP_TOKEN el mismo endpoint puede exponerse por túnel a los
    // clientes que no alcanzan loopback (por ejemplo Claude Desktop o ChatGPT).
    // CON IDENTIDAD, UN AGENTE ENTRA POR SU PROPIA CONCESIÓN (artículo 11).
    //
    // El token compartido deja de valer: la credencial dice de QUIÉN es el
    // reino que este agente va a tocar, y el jugador puede cortarla sola.
    if (identityEnabled()) {
      if (!req.caller) {
        res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Este agente no tiene una concesión válida." }, id: null });
        return;
      }
    } else {
      const expected = process.env.TORREON_MCP_TOKEN;
      if (expected && req.header("authorization") !== `Bearer ${expected}`) {
        res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Torreón requiere un token de acceso." }, id: null });
        return;
      }
    }
    const server = createMcpServer(reinoDe(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno de MCP" }, id: null });
      }
    }
  });

  app.get(mcpPath, (_req, res) => res.status(405).json({ error: "Este MVP usa MCP stateless por POST." }));
  app.delete(mcpPath, (_req, res) => res.status(405).json({ error: "Este MVP no mantiene sesiones MCP." }));

  // Con ruta secreta activa, /mcp no debe confirmar que aquí vive un Torreón.
  if (mcpPath !== "/mcp") {
    app.all("/mcp", (_req, res) => res.status(404).json({ error: "No encontrado." }));
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, "../../web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*splat", (_req, res) => res.sendFile(resolve(webDist, "index.html")));
  }

  // EL BORDE TRADUCE, NO DECIDE (artículo 7).
  //
  // Antes todo salía `400`: «no existe», «ya hay un frente comprometido» y un
  // fallo nuestro eran indistinguibles, y Unity no podía reaccionar a ninguno.
  // Ahora cada clase de fallo lleva su código y su motivo, y lo que NO es una
  // regla del reino sale como `500`: no se le echa la culpa a quien llamó.
  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const failure = describeFailure(error);
    res.status(failure.status).json({ error: failure.message, kind: failure.kind });
  });

  return app;
}
