import { z } from "zod";

/**
 * EL CONTRATO DE ENTRADA, UNO SOLO PARA LOS DOS TRANSPORTES.
 *
 * Antes `mcp.ts` validaba con esquemas y `app.ts` hacía `String(req.body?.x ?? "")`
 * a mano: la misma operación tenía dos contratos según por dónde entrara, y por
 * HTTP cualquier fallo salía como 400 sin decir qué (artículo 7).
 *
 * Aquí viven las formas. Este módulo no conoce Express ni el SDK de MCP: cada
 * transporte las usa a su manera.
 */

export const notificationEntityType = z.enum(["quest", "campaign", "act", "saga", "obligation"]);
export const notificationType = z.enum([
  "quest_created",
  "campaign_created",
  "battle_started",
  "quest_amendment_proposed",
  "battle_recontract_proposed",
  "quest_waiting_external",
  "quest_unblocked",
  "battle_lost",
  "recurring_obligation_due",
  "companion_result",
]);

export const dueRuleSchema = z.object({
  type: z.enum(["day_of_month", "day_of_week", "date", "unknown"]),
  day: z.number().int().min(0).max(31).optional(),
  date: z.string().max(40).optional(),
});

export const stepShape = {
  title: z.string().min(1).max(120).describe("Nombre breve y accionable del paso."),
  description: z.string().max(500).optional(),
  actor: z.enum(["user", "codex", "shared"]).describe("Quién ejecuta principalmente el paso."),
  evidence: z.string().min(1).max(300).describe("Evidencia que demuestra que el paso ocurrió."),
  evidenceKind: z
    .enum(["file", "link", "screenshot", "photo", "number", "text", "declaration"])
    .optional()
    .describe("Qué clase de prueba espera el paso. Prefiere artefactos verificables sobre declaraciones."),
  verificationHint: z
    .string()
    .max(300)
    .optional()
    .describe("Qué debe comprobarse en esa prueba antes de conceder impacto."),
  weight: z.number().int().min(1).max(100).describe("Daño causado al completarse; todos los pesos deben sumar 100."),
};

export const planShape = {
  campaignTitle: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Campaña a la que pertenece la Quest. OMÍTELO para una Quest Libre (standalone): no inventes una campaña ficticia sólo para rellenarlo."),
  title: z.string().min(1).max(120),
  intent: z.string().min(1).max(1000),
  outcome: z.string().min(1).max(1000),
  rationale: z.string().min(1).max(1000),
  durationMinutes: z.number().int().min(5).max(60).describe("Minutos de trabajo activo. Una Battle nunca pasa de 60: si el objetivo pide mas, descomponlo en varias Quests de un Acto."),
  wellbeingConstraints: z.array(z.string().min(1).max(200)).max(10).default([]),
  allowedApps: z.array(z.string().min(1).max(100)).max(20).default([]),
  steps: z.array(z.object(stepShape)).min(1).max(12),
};

export const amendmentChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD_STEP"), step: z.object(stepShape) }),
  z.object({
    type: z.literal("MODIFY_STEP"),
    stepId: z.string().uuid(),
    patch: z.object({
      title: stepShape.title.optional(),
      description: stepShape.description,
      actor: stepShape.actor.optional(),
      evidence: stepShape.evidence.optional(),
      evidenceKind: stepShape.evidenceKind,
      verificationHint: stepShape.verificationHint,
      weight: stepShape.weight.optional(),
    }),
  }),
  z.object({ type: z.literal("SUPERSEDE_STEP"), stepId: z.string().uuid(), reason: z.string().min(5).max(1000) }),
  z.object({
    type: z.literal("MARK_EXTERNAL_BLOCKER"),
    stepId: z.string().uuid(),
    blockedBy: z.string().min(2).max(200),
    blockedReason: z.string().min(5).max(1000),
    playerActionAvailable: z.boolean(),
    followUpAfter: z.string().max(100).optional(),
  }),
  z.object({ type: z.literal("UNBLOCK_STEP"), stepId: z.string().uuid(), reason: z.string().min(5).max(1000) }),
]);


// ---------------------------------------------------------------------------
// CUERPOS DE LAS RUTAS HTTP.
//
// Permisivos donde el Núcleo ya defiende la regla —no se le quita al reino el
// derecho a explicar por qué dijo que no— y estrictos donde el descuido del
// cliente producía un error incomprensible más adelante.
// ---------------------------------------------------------------------------

const questIntent = z.object({
  intent: z.string().min(1).max(1000),
  minutesAvailable: z.number().int().positive().max(600).optional(),
  actId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
});

const explicitAcceptance = z.object({ userAccepted: z.boolean() });

const characterBody = z.object({
  archetype: z.enum(["marques", "cordera"]),
  displayName: z.string().min(2).max(40),
  petName: z.string().min(1).max(40).optional(),
  title: z.string().min(2).max(60).optional(),
});

export const HTTP_BODIES = {
  "POST /api/character": characterBody,
  "POST /api/quests/from-intent": questIntent,
  "POST /api/quests/:questId/accept": explicitAcceptance,
  "POST /api/quests/:questId/start": z.object({ durationMinutes: z.number().int().min(5).max(60).optional() }),
  "POST /api/inventory/use": z.object({
    itemId: z.enum(["revive_tonic", "health_potion"]),
    target: z.enum(["roko", "marques", "cordera"]).optional(),
    questId: z.string().min(1).optional(),
  }),
  "POST /api/quests/:questId/discard": z.object({ reason: z.string().max(1000).optional() }),
  "POST /api/quests/:questId/battle/recontract": z.object({
    reason: z.string().min(1).max(1000),
    newDurationMinutes: z.number().int().min(5).max(60),
  }),
  "POST /api/quests/:questId/battle/recontract/accept": explicitAcceptance.extend({
    recontractId: z.string().min(1),
  }),
  "POST /api/quests/:questId/battle/retry": z.object({ durationMinutes: z.number().int().min(5).max(60).optional() }),
  "POST /api/quests/:questId/steps/:stepId/companion-assist": z.object({
    companion: z.enum(["opus", "codex", "claude", "gemini"]),
    source: z.string().max(100).optional(),
    sourceTool: z.string().max(200).optional(),
    executionRef: z.string().max(200).optional(),
    contributionSummary: z.string().min(1).max(2000),
  }),
  "POST /api/scale/classify": z.object({
    intent: z.string().min(1).max(1000),
    activeMinutes: z.number().int().nonnegative().optional(),
    externalWaitMinutes: z.number().int().nonnegative().optional(),
    naturalCampaigns: z.number().int().nonnegative().optional(),
  }),
  "POST /api/quests/:questId/amendments": z.object({
    reason: z.string().min(1).max(1000),
    proposedBy: z.string().max(120).optional(),
    changes: z.array(amendmentChangeSchema).min(1),
  }),
  "POST /api/quests/:questId/amendments/:amendmentId/accept": explicitAcceptance,
  "POST /api/campaigns/:campaignId/accept": explicitAcceptance,
  "POST /api/quests/:questId/steps/:stepId/evidence": z.object({
    summary: z.string().min(1).max(2000),
    source: z.enum(["user_declaration", "file", "mcp", "integration", "api"]).optional(),
    verdict: z.enum(["rejected", "partial", "accepted"]),
    reasoning: z.string().min(1).max(2000),
    impactAwarded: z.number().int().min(0).max(100),
  }),
  "POST /api/quests/:questId/steps/:stepId/artifacts": z.object({
    kind: z.enum(["file", "link", "text"]).optional(),
    path: z.string().max(1000).optional(),
    url: z.string().max(2000).optional(),
    text: z.string().max(20000).optional(),
    label: z.string().max(200).optional(),
    dataBase64: z.string().optional(),
    filename: z.string().max(300).optional(),
    mimeType: z.string().max(200).optional(),
  }),
  "POST /api/quests/:questId/horde-attacks/unexpected-requirement": z.object({
    stepId: z.string().min(1).optional(),
    reason: z.string().min(1).max(1000),
    damage: z.number().int().min(0).max(100),
  }),
  "POST /api/quests/:questId/steps/:stepId/verify": z.object({
    note: z.string().max(2000).optional(),
    artifactIds: z.array(z.string().min(1)).optional(),
  }),
  "POST /api/barracks/:heroId/availability": z.object({
    availability: z.enum(["connected", "available", "unavailable", "unknown"]),
  }),
  "POST /api/battle-memory/hint": z.object({ intent: z.string().min(1).max(1000) }),
  "POST /api/events/:eventId/invalidate": z.object({
    reason: z.string().min(1).max(1000),
    invalidatedBy: z.string().max(120).optional(),
  }),
  "POST /api/finance/transactions": z.object({
    direction: z.enum(["income", "expense"]),
    amount: z.number().positive(),
    occurredAt: z.string().max(40).optional(),
    recurringObligationId: z.string().min(1).optional(),
    questId: z.string().min(1).optional(),
    evidenceArtifactId: z.string().min(1).optional(),
    note: z.string().max(500).optional(),
    status: z.enum(["confirmed", "pending", "failed"]).optional(),
  }),
} as const;

export type HttpRoute = keyof typeof HTTP_BODIES;
