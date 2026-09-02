import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { QuestAmendmentChange, QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";

const stepShape = {
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

const planShape = {
  campaignTitle: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  intent: z.string().min(1).max(1000),
  outcome: z.string().min(1).max(1000),
  rationale: z.string().min(1).max(1000),
  durationMinutes: z.number().int().min(5).max(60).describe("Minutos de trabajo activo. Una Battle nunca pasa de 60: si el objetivo pide mas, descomponlo en varias Quests de un Acto."),
  wellbeingConstraints: z.array(z.string().min(1).max(200)).max(10).default([]),
  allowedApps: z.array(z.string().min(1).max(100)).max(20).default([]),
  steps: z.array(z.object(stepShape)).min(1).max(12),
};

const amendmentChangeSchema = z.discriminatedUnion("type", [
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
        "Actúa como el Códice de la Marca, Dungeon Master del mundo real. Convierte cualquier propósito —de cualquier dominio— en un resultado verificable y pasos cuyos pesos sumen 100. Negocia en la conversación y no crees estado hasta resumir el contrato. La aceptación es explícita. El tiempo y los clics no causan daño. La mejor partida es la que el jugador juega sin tocar el teléfono: la evidencia debe entrar por la conversación, no por la pantalla del juego. Si el archivo, la imagen o los datos están cargados en TU conversación, ábrelos, examínalos y regístralos con attest_evidence_artifact declarando qué viste. Si el archivo está en el disco donde corre este MCP, usa attach_evidence_artifact y el servidor comprobará los hechos (existe, tamaño, tipo, hash, extracto). Reutiliza un mismo artefacto entre pasos con reuse_evidence_artifact: no dupliques sus bytes ni su identidad, pero emite un veredicto independiente por paso. Solo después emite el veredicto con submit_quest_evidence citando los artifactIds; rejected causa 0, partial causa una parte y accepted concede todo el impacto restante. Un artefacto que el servidor no pudo comprobar nunca justifica accepted por sí solo. Si la realidad refuta el plan activo, no borres ni reescribas la historia: propón un amendment y aplícalo sólo tras aceptación explícita. Un bloqueo externo sin acción disponible coloca la quest en waiting_external. La horda sólo contraataca mediante record_unexpected_requirement cuando aparece una complicación real y concreta; jamás por silencio ni por inactividad. El único ataque temporal legítimo lo aplica el propio servidor al cruzar el 25%, 50%, 75% y 100% del plazo pactado en start_quest, y una quest en waiting_external suspende esa presión. Antes de crear estructura, usa classify_objective_scale: la escala la fijan los MINUTOS DE TRABAJO ACTIVO, nunca el calendario, y una microquest de quince minutos no necesita Acto ni Campaña.",
    },
  );

  server.registerTool(
    "get_realm_state",
    {
      title: "Consultar el reino",
      description:
        "Consulta la quest activa, el paso accionable, el progreso validado, la batalla y la consistencia del reino antes de aconsejar, evaluar o informar progreso. Si el reino viene vacío pero el jugador afirma estar en campaña, lee consistency.instance: casi siempre significa que su partida vive en otra instancia de Torreón (local frente a nube), no que el estado se haya perdido. Pregúntale antes de concluir que hubo un fallo.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const snapshot = await service.snapshot();
      return toolResult("Estado actual del reino recuperado.", { snapshot });
    },
  );

  server.registerTool(
    "get_quest_detail",
    {
      title: "Abrir el expediente de una misión",
      description:
        "Lee una misión completa: cada paso con su condición pactada, su impacto validado, los artefactos entregados y los veredictos emitidos. Úsala cuando el jugador pregunte en qué etapa va o qué le falta. get_realm_state responde qué ocurre en el reino; esta responde qué ocurre dentro de la misión.",
      inputSchema: { questId: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId }) => {
      const quest = await service.questDetail(questId);
      const paso = quest.currentStep
        ? `Paso actual: ${quest.currentStep.position}. ${quest.currentStep.title} (faltan ${quest.currentStep.remainingImpact} de ${quest.currentStep.weight}).`
        : "No queda ningún paso pendiente.";
      return toolResult(`«${quest.title}» va en ${quest.progress.percent}% validado. ${paso}`, { quest });
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
    "propose_quest_amendment",
    {
      title: "Proponer una adaptación de la quest",
      description:
        "Propone cambios materiales a una quest iniciada cuando nueva información demuestra que el contrato ya no representa la realidad. No aplica nada todavía: conserva impacto, eventos y evidencia hasta que el jugador acepte.",
      inputSchema: {
        questId: z.string().uuid(),
        reason: z.string().min(10).max(2000).describe("Qué cambió en la realidad y por qué el contrato actual dejó de ser correcto."),
        proposedBy: z.string().min(1).max(60).default("codice"),
        changes: z.array(amendmentChangeSchema).min(1).max(20),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, reason, proposedBy, changes }) => {
      const amendment = await service.proposeAmendment(questId, { reason, proposedBy, changes: changes as QuestAmendmentChange[] });
      return toolResult(`Amendment v${amendment.newVersion} propuesto. Nada cambia hasta que el jugador lo acepte explícitamente.`, { amendment });
    },
  );

  server.registerTool(
    "accept_quest_amendment",
    {
      title: "Aceptar una adaptación de la quest",
      description: "Aplica un amendment material únicamente después de la aceptación inequívoca del jugador; preserva impacto y eventos históricos.",
      inputSchema: {
        questId: z.string().uuid(),
        amendmentId: z.string().uuid(),
        userAccepted: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, amendmentId, userAccepted }) => {
      const result = await service.acceptAmendment(questId, amendmentId, userAccepted);
      return toolResult(
        result.quest.status === "waiting_external"
          ? `Plan v${result.quest.version} aceptado. El frente espera una condición externa y no exige acción del jugador.`
          : `Plan v${result.quest.version} aceptado. El impacto histórico permanece en ${result.battle.progress}.`,
        result,
      );
    },
  );

  server.registerTool(
    "start_quest",
    {
      title: "Iniciar la batalla",
      description:
        "Inicia una quest previamente aceptada cuando el usuario quiere comenzar la sesión de trabajo. AQUÍ arranca el reloj: no al redactar el borrador ni al aceptar el contrato. Desde este momento el servidor es la autoridad del tiempo y la Horda golpea al cruzar el 25%, 50%, 75% y 100% del plazo.",
      inputSchema: {
        questId: z.string().uuid(),
        durationMinutes: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe("Duración pactada de la Battle. Máximo 60 minutos; por defecto la duración del contrato."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, durationMinutes }) => {
      const quest = await service.start(questId, durationMinutes);
      const battle = (await service.snapshot()).battle;
      return toolResult(
        `La batalla «${quest.title}» comenzó. El plazo pactado es de ${battle?.durationMinutes ?? quest.durationMinutes} minutos y termina en ${quest.battle?.deadlineAt}.`,
        { quest, battle },
      );
    },
  );

  server.registerTool(
    "retry_battle",
    {
      title: "Reintentar una batalla perdida",
      description:
        "Vuelve a abrir el reloj de una Battle que venció con la Horda viva. Perder no borró nada: la evidencia validada, el impacto, el XP, el Aura y el historial siguen en pie; lo único que empieza de cero es el tiempo y el HP del Marqués. Si el plan ya no representa la realidad, propone antes un amendment.",
      inputSchema: {
        questId: z.string().uuid(),
        durationMinutes: z.number().int().min(1).max(60).optional().describe("Nuevo plazo pactado. Máximo 60 minutos."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, durationMinutes }) => {
      const result = await service.retryBattle(questId, durationMinutes);
      return toolResult(`«${result.quest.title}» vuelve al frente con ${result.battle.durationMinutes} minutos.`, result);
    },
  );

  server.registerTool(
    "classify_objective_scale",
    {
      title: "Elegir la escala del objetivo",
      description:
        "Decide si un propósito es una Quest, un Acto, una Campaña o una Saga. Mira MINUTOS DE TRABAJO ACTIVO, no calendario: diez minutos de trabajo más tres días esperando una firma siguen siendo una Quest en espera externa, jamás una Campaña. No crea nada: propone la escala y cuántas Battles, Actos y Campañas harían falta.",
      inputSchema: {
        intent: z.string().min(4).max(2000).describe("El objetivo tal como lo expresó el jugador."),
        activeMinutes: z.number().int().min(1).max(100000).optional().describe("Minutos de trabajo activo estimados."),
        externalWaitMinutes: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .optional()
          .describe("Espera ajena al jugador. No infla la escala; sólo explica el calendario."),
        naturalCampaigns: z.number().int().min(1).max(20).optional().describe("Campañas que el objetivo ya contiene de por sí."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ intent, activeMinutes, externalWaitMinutes, naturalCampaigns }) => {
      const proposal = service.classifyObjective(intent, { activeMinutes, externalWaitMinutes, naturalCampaigns });
      return toolResult(`Escala propuesta: ${proposal.scale}. ${proposal.reason}`, { proposal });
    },
  );

  server.registerTool(
    "create_saga",
    {
      title: "Abrir una saga",
      description:
        "Crea una Saga: un objetivo multisemana que agrupa dos o más Campañas. No la uses para nada más pequeño; una microquest no necesita padres.",
      inputSchema: {
        title: z.string().min(3).max(120),
        summary: z.string().max(500).optional(),
        estimatedActiveMinutes: z.number().int().min(0).max(1000000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const saga = await service.createSaga(args);
      return toolResult(`Saga «${saga.title}» abierta.`, { saga });
    },
  );

  server.registerTool(
    "create_campaign",
    {
      title: "Abrir una campaña",
      description:
        "Crea una Campaña: un objetivo significativo de 1 a 7 Actos, aproximadamente hasta una semana de trabajo activo. El escenario es ambientación visual, no jerarquía.",
      inputSchema: {
        title: z.string().min(3).max(120),
        summary: z.string().max(500).optional().describe("Qué recupera el reino con esta campaña."),
        objective: z.string().max(500).optional().describe("Resultado final verificable de toda la campaña."),
        sagaId: z.string().uuid().optional(),
        estimatedActiveMinutes: z.number().int().min(0).max(1000000).optional(),
        scenario: z.string().max(120).optional().describe("Ambientación visual. No es una unidad de la jerarquía."),
        bossTitle: z.string().max(120).optional().describe("Nombre del jefe final: hoy sólo representa la última Quest."),
        bossDescription: z.string().max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const campaign = await service.createCampaign(args);
      return toolResult(`Campaña «${campaign.title}» abierta.`, { campaign });
    },
  );

  server.registerTool(
    "create_act",
    {
      title: "Abrir un acto",
      description:
        "Crea un Acto: una fase jugable de una jornada, de 2 a 8 Battles y como máximo 8 horas de trabajo activo. Un Acto puede vivir sin Campaña si el objetivo cabe en un día.",
      inputSchema: {
        title: z.string().min(3).max(120),
        subtitle: z.string().max(200).optional().describe("Subtítulo del acto: «La comunicación bloqueada»."),
        campaignId: z.string().uuid().optional(),
        scenario: z.string().max(120).optional(),
        estimatedActiveMinutes: z.number().int().min(0).max(100000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const act = await service.createAct(args);
      return toolResult(`Acto «${act.title}» abierto.`, { act });
    },
  );

  server.registerTool(
    "assign_quest_to_act",
    {
      title: "Colocar una quest dentro de un acto",
      description: "Adopta una Quest ya existente dentro de un Acto. Un Acto no sostiene más de 8 Battles.",
      inputSchema: { questId: z.string().uuid(), actId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, actId }) => {
      const result = await service.assignQuestToAct(questId, actId);
      return toolResult(`«${result.quest.title}» ahora pertenece al acto «${result.act.title}».`, result);
    },
  );

  server.registerTool(
    "submit_quest_evidence",
    {
      title: "Evaluar evidencia de una quest",
      description: "Registra el hecho real y el veredicto razonado de Códice; solo el impacto validado se transforma en ataque.",
      inputSchema: {
        questId: z.string().uuid(),
        stepId: z.string().uuid(),
        summary: z.string().min(3).max(2000).describe("Resumen concreto de la evidencia observada o aportada."),
        source: z.enum(["user_declaration", "file", "mcp", "integration", "api"]),
        verdict: z.enum(["rejected", "partial", "accepted"]),
        reasoning: z.string().min(3).max(1000).describe("Por qué la evidencia satisface nada, parte o toda la condición pactada."),
        impactAwarded: z.number().int().min(0).max(100).describe("Daño concedido. Debe respetar el veredicto y el impacto restante del paso."),
        artifactIds: z
          .array(z.string().uuid())
          .max(20)
          .optional()
          .describe("Artefactos entregados con attach_evidence_artifact en los que se apoya este veredicto."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await service.submitEvidence(args.questId, args.stepId, args);
      const message = result.battle.isKo
        ? `KO. «${result.quest.title}» fue completada con evidencia validada.`
        : args.impactAwarded > 0
          ? `Impacto validado: ${args.impactAwarded}. La horda conserva ${result.battle.enemyHealth} puntos.`
          : "Evidencia registrada sin impacto; Códice explicó qué falta.";
      return toolResult(message, result);
    },
  );

  server.registerTool(
    "complete_quest_step",
    {
      title: "Completar un paso",
      description: "Compatibilidad del MVP: acepta toda la evidencia restante de un paso. Prefiere submit_quest_evidence para evaluaciones nuevas.",
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
    "plan_quest_from_intent",
    {
      title: "Pedir al motor que descomponga un objetivo",
      description:
        "Deja que el motor de Códice del servidor convierta una intención libre en el borrador de una quest. Úsala cuando prefieras el plan del motor en vez de redactarlo tú; el borrador sigue necesitando aceptación explícita.",
      inputSchema: {
        intent: z.string().min(8).max(2000).describe("La intención tal como la expresó el jugador."),
        minutesAvailable: z.number().int().min(5).max(60).optional().describe("Minutos de trabajo activo disponibles. Maximo 60: el resto se descompone."),
        actId: z.string().uuid().optional().describe("Acto que adopta esta Quest. Omitelo para una microquest sin padres."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ intent, minutesAvailable, actId }) => {
      const quest = await service.createDraftFromIntent(intent, minutesAvailable, actId);
      return toolResult(`Borrador «${quest.title}» creado por el motor; falta la aceptación explícita del usuario.`, { quest });
    },
  );

  server.registerTool(
    "attach_evidence_artifact",
    {
      title: "Entregar un documento al Códice",
      description:
        "Entrega un hecho real —un archivo del disco, un enlace o un texto— como artefacto de un paso. El servidor comprueba lo comprobable (existencia, tamaño, tipo, hash, extracto) y devuelve esa comprobación. No causa daño por sí solo: después evalúa con submit_quest_evidence citando el artifactId.",
      inputSchema: {
        questId: z.string().uuid(),
        stepId: z.string().uuid(),
        kind: z.enum(["file", "link", "text"]).describe("file usa una ruta local; link una URL; text un contenido literal."),
        path: z.string().max(1000).optional().describe("Ruta local del documento cuando kind es file."),
        url: z.string().max(2000).optional().describe("URL cuando kind es link."),
        text: z.string().max(20000).optional().describe("Contenido literal cuando kind es text."),
        label: z.string().max(200).optional().describe("Nombre corto del artefacto para el reino."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, stepId, kind, path, url, text, label }) => {
      const artifact = await service.attachArtifact(questId, stepId, { kind, path, url, text, label });
      const message = artifact.verification.verified
        ? `Artefacto comprobado por el servidor: ${artifact.verification.detail}`
        : `Artefacto registrado sin comprobar: ${artifact.verification.detail}`;
      return toolResult(message, { artifact });
    },
  );

  server.registerTool(
    "verify_step_evidence",
    {
      title: "Pedir el veredicto del motor",
      description:
        "Deja que el motor de Códice del servidor juzgue los artefactos ya entregados de un paso y aplique el impacto. Úsala cuando prefieras el veredicto del motor; si vas a juzgar tú la evidencia, usa submit_quest_evidence.",
      inputSchema: {
        questId: z.string().uuid(),
        stepId: z.string().uuid(),
        note: z.string().max(2000).optional().describe("Declaración del jugador sobre lo que ocurrió."),
        artifactIds: z.array(z.string().uuid()).max(20).optional().describe("Artefactos a considerar. Por defecto, todos los del paso."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, stepId, note, artifactIds }) => {
      const result = await service.verifyStep(questId, stepId, { note, artifactIds });
      const message = result.battle.isKo
        ? `KO. «${result.quest.title}» fue completada con evidencia validada.`
        : `Veredicto ${result.judgement.verdict}: ${result.judgement.reasoning} La horda conserva ${result.battle.enemyHealth} puntos.`;
      return toolResult(message, { ...result });
    },
  );

  server.registerTool(
    "reuse_evidence_artifact",
    {
      title: "Reutilizar una prueba en otro paso",
      description: "Vincula un Artifact ya existente a otro paso de la misma quest sin volver a cargar ni duplicar sus bytes. Cada paso conserva después su propio veredicto y razonamiento.",
      inputSchema: {
        questId: z.string().uuid(),
        artifactId: z.string().uuid(),
        targetStepId: z.string().uuid(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, artifactId, targetStepId }) => {
      const artifact = await service.reuseArtifact(questId, artifactId, targetStepId);
      return toolResult(`${artifact.label} quedó ligado al nuevo paso sin duplicar bytes. Ya puede evaluarse allí con un veredicto independiente.`, { artifact });
    },
  );

  server.registerTool(
    "attest_evidence_artifact",
    {
      title: "Atestiguar una prueba que tienes delante",
      description:
        "Usa esta herramienta cuando TÚ tengas el archivo, la imagen o los datos cargados en tu propia conversación y puedas examinarlos. Ábrelo, míralo de verdad y declara qué contiene. El jugador no debe tener que abrir el juego para entregar una prueba: la mejor partida es la que se juega sin tocar el teléfono. Después emite el veredicto con submit_quest_evidence citando este artifactId.",
      inputSchema: {
        questId: z.string().uuid(),
        stepId: z.string().uuid(),
        kind: z.enum(["file", "link", "text"]),
        label: z.string().min(1).max(200).describe("Nombre del artefacto examinado, por ejemplo «constancia-enero.pdf»."),
        observed: z
          .string()
          .min(10)
          .max(4000)
          .describe(
            "Qué viste literalmente al abrirlo: fechas, nombres, cifras, estados, lo que aparece en la pantalla o en el documento. No escribas lo que el jugador afirma, escribe lo que TÚ observaste.",
          ),
        witness: z.string().min(1).max(60).describe("Quién examinó el artefacto: chatgpt, codex, claude."),
        url: z.string().max(2000).optional(),
        mimeType: z.string().max(120).optional(),
        bytes: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, stepId, kind, label, observed, witness, url, mimeType, bytes }) => {
      const artifact = await service.attestArtifact(questId, stepId, { kind, label, observed, witness, url, mimeType, bytes });
      return toolResult(`Artefacto atestiguado por ${witness}: ${artifact.label}. Ya puedes emitir el veredicto citando su artifactId.`, {
        artifact,
      });
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

  server.registerTool(
    "record_unexpected_requirement",
    {
      title: "Registrar un contraataque por complicación real",
      description:
        "Registra una exigencia nueva e imprevista del mundo real. Produce LifeEvent unexpected_requirement y GameEvent horde_attack; nunca debe usarse sólo porque pasó tiempo ni contra una quest waiting_external.",
      inputSchema: {
        questId: z.string().uuid(),
        stepId: z.string().uuid().optional(),
        reason: z.string().min(10).max(1000),
        damage: z.number().int().min(1).max(50).describe("Impacto proporcional de esta complicación real sobre el frente."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, stepId, reason, damage }) => {
      const result = await service.recordUnexpectedRequirement(questId, { stepId, reason, damage });
      return toolResult(`La Horda contraatacó por una complicación real: -${damage} HP. El Marqués conserva ${result.battle.playerHealth} HP.`, result);
    },
  );

  return server;
}
