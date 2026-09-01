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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    next();
  });
  app.options("*splat", (_req, res) => res.sendStatus(204));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    const snapshot = await service.snapshot();
    res.json({ status: "ok", server: "torreon", version: "0.1.0", updatedAt: snapshot.realm.updatedAt });
  });

  app.get("/api/state", async (_req, res, next) => {
    try {
      res.json(await service.snapshot());
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

  app.post("/api/reset", async (_req, res, next) => {
    try {
      res.json(await service.reset());
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp", async (req: Request, res: Response) => {
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

  app.get("/mcp", (_req, res) => res.status(405).json({ error: "Este MVP usa MCP stateless por POST." }));
  app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Este MVP no mantiene sesiones MCP." }));

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
