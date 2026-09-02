import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { demoQuest, QuestService } from "./quest-service.js";

export function createHttpApp(service: QuestService) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
  });
  app.options("*splat", (_req, res) => res.sendStatus(204));
  // Las capturas y documentos del jugador llegan en base64 dentro del cuerpo.
  app.use(express.json({ limit: "32mb" }));

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

  app.post("/api/quests/from-intent", async (req, res, next) => {
    try {
      const snapshot = await service.snapshot();
      if (snapshot.currentQuest && !["completed", "abandoned"].includes(snapshot.currentQuest.status)) {
        res.json({ quest: snapshot.currentQuest, reused: true });
        return;
      }
      const minutes = Number(req.body?.minutesAvailable);
      res.status(201).json({
        quest: await service.createDraftFromIntent(String(req.body?.intent ?? ""), Number.isFinite(minutes) ? minutes : undefined),
        reused: false,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/accept", async (req, res, next) => {
    try {
      res.json({ quest: await service.accept(req.params.questId, req.body?.userAccepted === true) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/quests/:questId/start", async (req, res, next) => {
    try {
      res.json({ quest: await service.start(req.params.questId) });
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

  app.post("/api/quests/:questId/steps/:stepId/evidence", async (req, res, next) => {
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

  app.post("/api/quests/:questId/steps/:stepId/artifacts", async (req, res, next) => {
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

  app.post("/api/quests/:questId/steps/:stepId/verify", async (req, res, next) => {
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

  app.post("/api/reset", async (_req, res, next) => {
    try {
      res.json(await service.reset());
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
    const expected = process.env.TORREON_MCP_TOKEN;
    if (expected && req.header("authorization") !== `Bearer ${expected}`) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Torreón requiere un token de acceso." }, id: null });
      return;
    }
    const server = createMcpServer(service);
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

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Error inesperado";
    res.status(400).json({ error: message });
  });

  return app;
}
