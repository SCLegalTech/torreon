import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";

const stepShape = {
  title: z.string().min(1).max(120).describe("Nombre breve y accionable del paso."),
  description: z.string().max(500).optional(),
  actor: z.enum(["user", "codex", "shared"]).describe("Quién ejecuta principalmente el paso."),
  evidence: z.string().min(1).max(300).describe("Evidencia que demuestra que el paso ocurrió."),
  weight: z.number().int().min(1).max(100).describe("Daño causado al completarse; todos los pesos deben sumar 100."),
};

const planShape = {
  campaignTitle: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  intent: z.string().min(1).max(1000),
  outcome: z.string().min(1).max(1000),
  rationale: z.string().min(1).max(1000),
  durationMinutes: z.number().int().min(5).max(240),
  wellbeingConstraints: z.array(z.string().min(1).max(200)).max(10).default([]),
  allowedApps: z.array(z.string().min(1).max(100)).max(20).default([]),
  steps: z.array(z.object(stepShape)).min(1).max(12),
};

function toolResult<T extends object>(message: string, data: T) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createMcpServer(service: QuestService): McpServer {
  const server = new McpServer(
    { name: "torreon", version: "0.1.0" },
    {
      instructions:
        "Actúa como el Códice de la Marca. Antes de crear una quest, mejora la intención, define un resultado verificable, restricciones de bienestar, evidencia y pasos cuyos pesos sumen 100. Negocia en la conversación y no llames create_quest_draft hasta resumir el contrato. accept_quest exige aceptación explícita; start_quest solo cuando el usuario quiera comenzar. El tiempo no causa daño: solo complete_quest_step con evidencia.",
    },
  );

  server.registerTool(
    "get_realm_state",
    {
      title: "Consultar el reino",
      description: "Consulta el estado financiero, la quest actual y la batalla antes de aconsejar, planear o informar progreso.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const snapshot = await service.snapshot();
      return toolResult("Estado actual del reino recuperado.", { snapshot });
    },
  );

  server.registerTool(
    "create_quest_draft",
    {
      title: "Redactar una quest",
      description: "Crea el borrador del contrato de una quest ya negociada. No la acepta ni la inicia.",
      inputSchema: planShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const quest = await service.createDraft(args as QuestPlanInput);
      return toolResult(`Borrador «${quest.title}» creado; falta la aceptación explícita del usuario.`, { quest });
    },
  );

  server.registerTool(
    "revise_quest_draft",
    {
      title: "Reformular una quest",
      description: "Reemplaza el contrato de una quest que todavía está en borrador tras nuevas indicaciones del usuario.",
      inputSchema: { questId: z.string().uuid(), ...planShape },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, ...plan }) => {
      const quest = await service.reviseDraft(questId, plan as QuestPlanInput);
      return toolResult(`Borrador «${quest.title}» reformulado.`, { quest });
    },
  );

  server.registerTool(
    "accept_quest",
    {
      title: "Aceptar una quest",
      description: "Registra que el usuario aceptó explícitamente el contrato de una quest. No la inicia.",
      inputSchema: {
        questId: z.string().uuid(),
        userAccepted: z.boolean().describe("Debe ser true únicamente tras una aceptación inequívoca del usuario."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, userAccepted }) => {
      const quest = await service.accept(questId, userAccepted);
      return toolResult(`«${quest.title}» fue aceptada y está lista para comenzar.`, { quest });
    },
  );

  server.registerTool(
    "start_quest",
    {
      title: "Iniciar la batalla",
      description: "Inicia una quest previamente aceptada cuando el usuario quiere comenzar la sesión de trabajo.",
      inputSchema: { questId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId }) => {
      const quest = await service.start(questId);
      return toolResult(`La batalla «${quest.title}» comenzó.`, { quest, battle: { enemyHealth: 100, progress: 0 } });
    },
  );

  server.registerTool(
    "complete_quest_step",
    {
      title: "Completar un paso",
      description: "Marca un paso de la quest activa como completado cuando existe evidencia suficiente y aplica su daño a la horda.",
      inputSchema: {
        questId: z.string().uuid(),
        stepId: z.string().uuid(),
        evidenceNote: z.string().min(3).max(1000).describe("Resumen concreto de la evidencia observada o aportada."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, stepId, evidenceNote }) => {
      const result = await service.completeStep(questId, stepId, evidenceNote);
      const message = result.battle.isKo
        ? `KO. «${result.quest.title}» fue completada.`
        : `Impacto confirmado. La horda conserva ${result.battle.enemyHealth} puntos de vida.`;
      return toolResult(message, result);
    },
  );

  server.registerTool(
    "abandon_quest",
    {
      title: "Abandonar una quest",
      description: "Retira una quest no terminada cuando el usuario lo solicita explícitamente.",
      inputSchema: { questId: z.string().uuid(), reason: z.string().min(1).max(500) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ questId, reason }) => {
      const quest = await service.abandon(questId, reason);
      return toolResult(`La quest «${quest.title}» fue abandonada.`, { quest });
    },
  );

  return server;
}

