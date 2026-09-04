import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NotificationEntityType, NotificationType, QuestAmendmentChange, QuestPlanInput } from "./domain.js";
import { QuestService } from "./quest-service.js";

const notificationEntityType = z.enum(["quest", "campaign", "act", "saga", "obligation"]);
const notificationType = z.enum([
  "quest_created",
  "campaign_created",
  "quest_amendment_proposed",
  "battle_recontract_proposed",
  "quest_waiting_external",
  "quest_unblocked",
  "battle_lost",
  "recurring_obligation_due",
  "companion_result",
]);

const dueRuleSchema = z.object({
  type: z.enum(["day_of_month", "day_of_week", "date", "unknown"]),
  day: z.number().int().min(0).max(31).optional(),
  date: z.string().max(40).optional(),
});

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
        "Actúa como el Códice de la Marca, Dungeon Master del mundo real. Convierte cualquier propósito —de cualquier dominio— en un resultado verificable y pasos cuyos pesos sumen 100. Negocia en la conversación y no crees estado hasta resumir el contrato. La aceptación es explícita. El tiempo y los clics no causan daño. La mejor partida es la que el jugador juega sin tocar el teléfono: la evidencia debe entrar por la conversación, no por la pantalla del juego. Si el archivo, la imagen o los datos están cargados en TU conversación, ábrelos, examínalos y regístralos con attest_evidence_artifact declarando qué viste. Si el archivo está en el disco donde corre este MCP, usa attach_evidence_artifact y el servidor comprobará los hechos (existe, tamaño, tipo, hash, extracto). Reutiliza un mismo artefacto entre pasos con reuse_evidence_artifact: no dupliques sus bytes ni su identidad, pero emite un veredicto independiente por paso. Solo después emite el veredicto con submit_quest_evidence citando los artifactIds; no existe ningún atajo para cerrar un paso sin veredicto razonado; rejected causa 0, partial causa una parte y accepted concede todo el impacto restante. Un artefacto que el servidor no pudo comprobar nunca justifica accepted por sí solo. Si la realidad refuta el plan activo, no borres ni reescribas la historia: propón un amendment y aplícalo sólo tras aceptación explícita. Un bloqueo externo sin acción disponible coloca la quest en waiting_external. La horda sólo contraataca mediante record_unexpected_requirement cuando aparece una complicación real y concreta; jamás por silencio ni por inactividad. El único ataque temporal legítimo lo aplica el propio servidor en diez ventanas repartidas por el plazo pactado en start_quest —con críticos derivados de la semilla del combate, nunca de un dado del cliente—, y una quest en waiting_external suspende esa presión. El grupo es Roku (guardia, escudo primero), Marqués (arquero: su caída cierra el intento) y Cordera (sanadora), más un cuarto slot que sólo ocupa un compañero que ejecutó algo real. El personaje se llama ROKU, con U: escríbelo siempre así aunque su id interno siga siendo `roko`. Cuando uses de verdad a Opus, Codex, Claude o Gemini para un paso, decláralo: lo más barato es pasar sourceProvider, sourceTool y executionRef dentro de submit_quest_evidence o verify_step_evidence, y el Core registra la participación y —si la evidencia se acepta— el assist validado en UNA sola operación autoritativa. record_companion_assist sigue sirviendo para mostrar el despliegue ANTES de la validación y ahora es idempotente: repetir la misma ejecución real no duplica nada. Un agente no golpea por estar disponible ni por que lo llames muchas veces; golpea cuando su contribución termina validada, y cada compañero cuenta como mucho una vez por paso. Nunca llames a un agente sólo para subir estadísticas: cada ejecución debe tener intención de contribución sobre el paso actual, y si existe una herramienta determinista especializada, prefiérela antes que razonar de más. Consulta get_barracks para saber quién ha peleado de verdad, y get_planning_hint antes de proponer un plazo: si el reino ya sabe que un trabajo así toma 47 minutos, no vuelvas a proponer 20 sin una razón. Reconocer un playbook no lo acepta ni lo inicia: pregunta. El nivel de un héroe es gameplay y NUNCA un permiso: enviar, firmar, pagar, borrar o desplegar siguen exigiendo autorización humana real sea cual sea el nivel. Y si registraste un hecho por error operativo, no lo borres ni lo reescribas: anúlalo con invalidate_event explicando por qué. La Horda son CUATRO enemigos con rostro: un arquero puede saltarse a Roku y un asesino puede caer sobre Cordera. Neutralizar a los cuatro detiene la presión pero NO es victoria: la victoria la firma el contrato validado al 100%. Puede haber varias campañas activas a la vez, pero UNA sola Battle con reloj: si ya hay una comprometida, otra quest se consulta pero no se inicia. Antes de crear estructura, usa classify_objective_scale: la escala la fijan los MINUTOS DE TRABAJO ACTIVO, nunca el calendario, y una microquest de quince minutos no necesita Acto ni Campaña.",
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
        "Inicia una quest previamente aceptada cuando el usuario quiere comenzar la sesión de trabajo. AQUÍ arranca el reloj: no al redactar el borrador ni al aceptar el contrato. Desde este momento el servidor es la autoridad del tiempo. Al iniciar se genera, con una semilla persistida, una formación de CUATRO enemigos tomada de un pool de arquetipos, cuyos máximos suman los 100 puntos del contrato. La presión es CONTINUA: cada enemigo vivo aporta su ritmo por minuto y el Core lo liquida por ventanas de un minuto, eligiendo objetivo según el arquetipo —el Arquero del Vacío dispara por encima de Roko, el Acechador caza al más herido, el Rompeescudos gasta escudo al doble—, con ventanas críticas derivadas de la misma semilla. Matar a un enemigo le quita su presión y su pasiva al instante.",
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
        `La batalla «${quest.title}» comenzó: ${battle?.durationMinutes ?? quest.durationMinutes} min hasta ${quest.battle?.deadlineAt}, contra ${battle?.enemies.map((enemy) => `${enemy.name} (${enemy.maxHealth})`).join(", ")}.`,
        { quest, battle },
      );
    },
  );

  server.registerTool(
    "get_inventory",
    {
      title: "Ver el zurrón",
      description: "Devuelve los objetos que quedan. Los objetos se gastan: el Core es el único que decrementa.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const { inventory } = await service.snapshot();
      const detail = inventory.items.map((entry) => `${entry.itemId} ×${entry.quantity}`).join(", ") || "vacío";
      return toolResult(`Zurrón: ${detail}.`, { inventory });
    },
  );

  server.registerTool(
    "use_inventory_item",
    {
      title: "Usar un objeto",
      description:
        "Aplica un objeto sobre un miembro del grupo. El Tónico de Retorno levanta a un CAÍDO con parte de su vida; la Poción Carmesí cura a quien sigue EN PIE y nunca resucita. El Core valida existencia, cantidad y estado del destino antes de aplicar nada.",
      inputSchema: {
        itemId: z.enum(["revive_tonic", "health_potion"]),
        target: z.enum(["roko", "marques", "cordera"]),
        questId: z
          .string()
          .uuid()
          .optional()
          .describe("Frente sobre el que se usa. Con dos Battles esperando auxilio, omitirlo elige la primera y puede no ser la que el jugador mira."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ itemId, target, questId }) => {
      const result = await service.useInventoryItem(itemId, target, questId);
      return toolResult(`${result.message} Quedan ${result.remaining}.`, result);
    },
  );

  server.registerTool(
    "recover_party",
    {
      title: "Retirar al grupo a las Barracas",
      description:
        "LA ÚLTIMA RUTA LEGAL. Sólo cuando el frente ya NO corre —plazo vencido o Marqués caído—, alguien está en el suelo y no queda ninguna otra salida: sin Tónico de Retorno, `retry_battle` se niega con razón y el frente quedaría clavado para siempre. Retirarse cierra el intento y devuelve a los caídos con el MÍNIMO de reentrada que declara el Core. NO concede progreso de Quest, NO crea evidencia, NO cura a la Horda ni le quita el daño recibido, NO devuelve consumibles gastados y NO borra heridas ni historial. No es una resurrección dentro del intento: el intento se cierra.",
      inputSchema: { questId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId }) => {
      const result = await service.recoverParty(questId);
      return toolResult(
        `El grupo se retira a las Barracas: vuelve(n) con ${result.minHealth} HP. El frente sigue abierto y hay que repactar el tiempo.`,
        result,
      );
    },
  );

  server.registerTool(
    "record_companion_assist",
    {
      title: "Registrar la ayuda real de un compañero",
      description:
        "Llámala INMEDIATAMENTE después de usar de verdad a Opus, Codex, Claude o Gemini para este paso. No basta con que el compañero esté disponible ni con que el jugador diga que lo usó: esto declara una ejecución real. El primer compañero registrado ocupa el cuarto slot del grupo. Todavía NO concede daño: el combo llega sólo si la evidencia del paso termina aceptada, y un mismo compañero cuenta una sola vez por paso.",
      inputSchema: {
        questId: z.string().uuid(),
        stepId: z.string().uuid(),
        companion: z.enum(["opus", "codex", "claude", "gemini"]),
        source: z.enum(["mcp", "internal", "integration"]).optional(),
        sourceTool: z.string().max(120).optional().describe("Herramienta concreta que se ejecutó, p. ej. update_client_portal."),
        executionRef: z.string().max(200).optional().describe("Referencia de la ejecución, para poder rastrearla."),
        contributionSummary: z.string().min(5).max(500).describe("Qué hizo realmente, en una frase."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const { assist, duplicate } = await service.recordCompanionAssist(args);
      return toolResult(
        duplicate
          ? `Esa misma ejecución de ${assist.companion} ya estaba registrada. Mismo hecho real, mismo registro: no se duplican stats, XP ni combo.`
          : `Ayuda de ${assist.companion} registrada como pendiente de validación. El combo llegará si la evidencia del paso se acepta.`,
        { assist, duplicate },
      );
    },
  );

  server.registerTool(
    "propose_battle_recontract",
    {
      title: "Repactar el tiempo de una batalla en curso",
      description:
        "Cuando aparece una exigencia real que el contrato no contemplaba, propone un nuevo plazo ANTES de que venza el actual. No es una derrota: el intento se cierra como repactado, no como vencido, y no se emite battle_lost. El nuevo intento sigue sin poder pasar de 60 minutos —55 + 30 no son 85— y todo el estado de combate se preserva: heridas, caídos, escudo y Horda.",
      inputSchema: {
        questId: z.string().uuid(),
        reason: z.string().min(10).max(500).describe("Qué exigencia real apareció."),
        newDurationMinutes: z.number().int().min(1).max(60),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, reason, newDurationMinutes }) => {
      const battle = await service.proposeBattleRecontract(questId, { reason, newDurationMinutes });
      return toolResult(
        `Nuevo pacto temporal propuesto: ${newDurationMinutes} min (id ${battle.pendingRecontract?.id}). Falta la aceptación del jugador, y hay que sellarlo con ese id.`,
        { battle },
      );
    },
  );

  server.registerTool(
    "accept_battle_recontract",
    {
      title: "Aceptar el nuevo pacto temporal",
      description:
        "Aplica el nuevo plazo tras aceptación explícita del jugador y abre un intento nuevo sobre el MISMO campo de batalla. Exige el `recontractId` de la propuesta concreta: si propusiste 30 min y luego 15, hay que saber cuál se está sellando. El id viene en `battle.pendingRecontract.id`.",
      inputSchema: {
        questId: z.string().uuid(),
        recontractId: z.string().uuid().describe("Id de la propuesta que el jugador está aceptando."),
        userAccepted: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, recontractId, userAccepted }) => {
      const battle = await service.acceptBattleRecontract(questId, recontractId, userAccepted);
      return toolResult(`El frente sigue igual con ${battle.durationMinutes} min nuevos (intento ${battle.attempt}).`, { battle });
    },
  );

  server.registerTool(
    "retry_battle",
    {
      title: "Reintentar una batalla perdida",
      description:
        "Abre un intento nuevo sobre el MISMO campo de batalla cuando el plazo venció. REPLANIFICAR NO CURA: el grupo conserva sus heridas, los caídos siguen caídos, el escudo no se rellena y la Horda mantiene su daño y su composición. Lo único que se repacta es el tiempo. Si el Marqués cayó, hay que levantarlo con un Tónico de Retorno antes de poder reintentar.",
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
    "create_campaign_draft",
    {
      title: "Trazar una campaña",
      description:
        "Crea una Campaña REAL en el reino, en estado borrador. Una Campaña es un objetivo significativo de varias jornadas: agrupa Actos y Quests por ID, no por parecido de nombre. Escribir «campaignTitle» en una quest NO crea una campaña. El borrador no vive hasta que el jugador lo sella con accept_campaign, y sellarlo tampoco inicia ninguna Battle. Puedes proponer Actos iniciales, pero no hace falta planificar semanas enteras: la campaña crece cuando la realidad revela los frentes.",
      inputSchema: {
        title: z.string().min(3).max(120).describe("Nombre de la gesta, corto y evocador."),
        intent: z.string().max(1000).optional().describe("La intención literal del jugador."),
        summary: z.string().max(500).optional().describe("Qué recupera el reino con esta campaña."),
        objective: z.string().max(500).optional().describe("Resultado final verificable de toda la campaña."),
        rationale: z.string().max(1000).optional().describe("Por qué esta agrupación produce el resultado."),
        sagaId: z.string().uuid().optional(),
        estimatedActiveMinutes: z.number().int().min(0).max(1000000).optional().describe("Minutos de TRABAJO ACTIVO. No cuentes esperas ajenas al jugador."),
        estimatedCalendarDays: z.number().int().min(0).max(400).optional().describe("Horizonte de calendario. No cambia la escala por sí solo."),
        scenario: z.string().max(120).optional().describe("Ambientación visual. No es una unidad de la jerarquía."),
        bossTitle: z.string().max(120).optional(),
        bossDescription: z.string().max(300).optional(),
        initialActs: z
          .array(
            z.object({
              title: z.string().min(3).max(120),
              subtitle: z.string().max(200).optional(),
              outcome: z.string().max(500).optional(),
              estimatedActiveMinutes: z.number().int().min(0).max(100000).optional(),
            }),
          )
          .max(7)
          .optional()
          .describe("Actos iniciales razonables. Opcional: una campaña puede empezar sin conocerlos todos."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await service.createCampaignDraft(args);
      return toolResult(
        `Campaña «${result.campaign.title}» trazada en borrador con ${result.acts.length} acto(s). Falta el sello explícito del jugador.`,
        result,
      );
    },
  );

  server.registerTool(
    "revise_campaign_draft",
    {
      title: "Reformular una campaña en borrador",
      description:
        "Corrige un pacto que el jugador todavía no ha sellado. Sólo funciona mientras la campaña esté en borrador y nunca borra historia: los Actos que ya tienen Quests se conservan intactos aunque envíes otros initialActs.",
      inputSchema: {
        campaignId: z.string().uuid(),
        title: z.string().min(3).max(120).optional(),
        intent: z.string().max(1000).optional(),
        summary: z.string().max(500).optional(),
        objective: z.string().max(500).optional(),
        rationale: z.string().max(1000).optional(),
        estimatedActiveMinutes: z.number().int().min(0).max(1000000).optional(),
        estimatedCalendarDays: z.number().int().min(0).max(400).optional(),
        scenario: z.string().max(120).optional(),
        bossTitle: z.string().max(120).optional(),
        bossDescription: z.string().max(300).optional(),
        initialActs: z
          .array(
            z.object({
              title: z.string().min(3).max(120),
              subtitle: z.string().max(200).optional(),
              outcome: z.string().max(500).optional(),
              estimatedActiveMinutes: z.number().int().min(0).max(100000).optional(),
            }),
          )
          .max(7)
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ campaignId, ...patch }) => {
      const result = await service.reviseCampaignDraft(campaignId, patch);
      return toolResult(`El pacto de «${result.campaign.title}» fue reformulado.`, result);
    },
  );

  server.registerTool(
    "accept_campaign",
    {
      title: "Sellar el pacto de una campaña",
      description:
        "Activa una campaña en borrador SÓLO tras aceptación explícita del jugador. Aceptar no cierra ninguna otra campaña —pueden estar varias activas a la vez— y no inicia ninguna Battle. Es idempotente: volver a sellar una campaña ya activa no rompe nada.",
      inputSchema: {
        campaignId: z.string().uuid(),
        userAccepted: z.literal(true).describe("Debe ser true y provenir de una aceptación real del jugador."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ campaignId, userAccepted }) => {
      const campaign = await service.acceptCampaign(campaignId, userAccepted);
      return toolResult(`«${campaign.title}» quedó activa. Los demás frentes siguen abiertos.`, { campaign });
    },
  );

  server.registerTool(
    "abandon_campaign",
    {
      title: "Retirar una campaña",
      description:
        "Retira una campaña trazada por error o que dejó de representar la realidad. No borra nada: las quests conservan su id, su estado y su historia, y sólo dejan de colgar de ella. Una campaña ya conquistada es historia y no se retira.",
      inputSchema: {
        campaignId: z.string().uuid(),
        reason: z.string().min(3).max(500).describe("Qué cambió en la realidad para retirarla."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ campaignId, reason }) => {
      const campaign = await service.abandonCampaign(campaignId, reason);
      return toolResult(`«${campaign.title}» quedó retirada.`, { campaign });
    },
  );

  server.registerTool(
    "plan_campaign_from_intent",
    {
      title: "Pedir al motor que trace una campaña",
      description:
        "Convierte una intención amplia en un borrador de Campaña con Actos iniciales razonables, usando la clasificación de escala del servidor. No crea Battles ni salta la aceptación: sigue haciendo falta accept_campaign. Úsala cuando el objetivo claramente excede una jornada; para algo de una hora, crea una Quest suelta y no fabriques jerarquía ceremonial.",
      inputSchema: {
        intent: z.string().min(8).max(2000).describe("El objetivo tal como lo expresó el jugador."),
        activeMinutes: z.number().int().min(1).max(1000000).optional().describe("Minutos de trabajo activo estimados."),
        calendarDays: z.number().int().min(0).max(400).optional().describe("Horizonte declarado, en días."),
        fronts: z
          .array(z.string().min(2).max(200))
          .max(7)
          .optional()
          .describe("Frentes conocidos ahora mismo. Cada uno propone un Acto inicial; no inventes los que no existen."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await service.planCampaignFromIntent(args);
      return toolResult(
        `Campaña «${result.campaign.title}» propuesta (${result.proposal.scale}): ${result.proposal.reason} Falta el sello del jugador.`,
        result,
      );
    },
  );

  server.registerTool(
    "focus_campaign",
    {
      title: "Poner una campaña en foco",
      description:
        "Cambia la campaña que el jugador mira ahora. Sólo mueve `focusedCampaignId`: NO desactiva ninguna otra campaña, NO inicia ninguna Battle y NO toca `engagedQuestId`. Varias campañas siguen activas a la vez —trabajo, firma, desarrollo, personal— y las que no están en foco no atacan al jugador. Es idempotente. Usa null para soltar el foco.",
      inputSchema: { campaignId: z.string().uuid().nullable().describe("Campaña a enfocar, o null para soltar el foco.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ campaignId }) => {
      const snapshot = await service.focusCampaign(campaignId);
      const focused = snapshot.realm.campaigns.find((candidate) => candidate.id === snapshot.hierarchy.focusedCampaignId);
      return toolResult(
        focused
          ? `Campaña en foco: «${focused.title}». Las demás siguen activas y no se inició ninguna batalla.`
          : "El reino quedó sin campaña en foco.",
        { hierarchy: snapshot.hierarchy, currentQuest: snapshot.currentQuest },
      );
    },
  );

  server.registerTool(
    "create_act",
    {
      title: "Abrir un acto",
      description:
        "Crea un Acto: una fase jugable de una jornada, de 2 a 8 Battles y como máximo 8 horas de trabajo activo. Un Acto puede vivir sin Campaña si el objetivo cabe en un día. Los Actos de una misma Campaña son PARALELOS por defecto: un Acto sólo se bloquea si declara `dependsOnActIds` y esos Actos aún no están cerrados.",
      inputSchema: {
        title: z.string().min(3).max(120),
        subtitle: z.string().max(200).optional().describe("Subtítulo del acto: «La comunicación bloqueada»."),
        outcome: z.string().max(500).optional().describe("Qué deja hecho este acto cuando cierra."),
        campaignId: z.string().uuid().optional(),
        scenario: z.string().max(120).optional(),
        estimatedActiveMinutes: z.number().int().min(0).max(100000).optional(),
        dependsOnActIds: z
          .array(z.string().uuid())
          .max(7)
          .optional()
          .describe("Actos que deben cerrarse antes que este. Omítelo para un Acto en paralelo, que es lo normal."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const act = await service.createAct(args);
      return toolResult(`Acto «${act.title}» abierto.`, { act });
    },
  );

  server.registerTool(
    "assign_quest",
    {
      title: "Vincular una quest a una campaña o a un acto",
      description:
        "Enlaza por ID una Quest YA EXISTENTE con una Campaña y, si conviene, con un Acto. NO la recrea: conserva su id, su estado, sus fechas, su evidencia y su historial. Úsala para adoptar quests antiguas que sólo tenían `campaignTitle` como texto. Un `campaignTitle` parecido nunca basta para inferir la relación: aquí se declara. Es idempotente y rechaza un actId que pertenezca a otra campaña.",
      inputSchema: {
        questId: z.string().uuid(),
        campaignId: z.string().uuid().optional().describe("Campaña de destino. Si das actId, se deduce de él."),
        actId: z.string().uuid().optional().describe("Acto de destino. Opcional: una quest puede colgar directamente de la campaña."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, campaignId, actId }) => {
      const result = await service.assignQuest(questId, { campaignId, actId });
      return toolResult(
        result.act
          ? `«${result.quest.title}» ahora pertenece al acto «${result.act.title}».`
          : `«${result.quest.title}» ahora pertenece a la campaña «${result.campaign!.title}».`,
        result,
      );
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
        sourceProvider: z
          .enum(["opus", "codex", "claude", "gemini"])
          .optional()
          .describe(
            "Compañero REAL cuya ejecución produjo esta prueba. Declararlo aquí registra su participación y, si el veredicto la acepta, su assist validado en UNA sola operación: no hace falta llamar antes a record_companion_assist.",
          ),
        sourceTool: z.string().max(120).optional().describe("Herramienta concreta que se ejecutó, p. ej. gmail_search_inbox."),
        executionRef: z.string().max(200).optional().describe("Referencia de esa ejecución. Repetirla NO duplica la participación."),
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

  // `complete_quest_step` YA NO SE EXPONE.
  //
  // Concedía todo el impacto restante de un paso sin veredicto razonado, y eso
  // debilitaba el principio del juego: EVIDENCIA REAL -> VALIDACIÓN -> IMPACTO.
  // El camino es attach/attest del artefacto y después submit_quest_evidence o
  // verify_step_evidence. El método sigue en el servicio, marcado como legado,
  // para la quest demostrativa y las pruebas; no para gameplay real.

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
        campaignId: z.string().uuid().optional().describe("Campaña que adopta esta Quest cuando no hace falta un Acto intermedio."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ intent, minutesAvailable, actId, campaignId }) => {
      const quest = await service.createDraftFromIntent(intent, minutesAvailable, actId, campaignId);
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
        sourceProvider: z
          .enum(["opus", "codex", "claude", "gemini"])
          .optional()
          .describe("Compañero real cuya ejecución produjo la prueba. Registra su participación en la misma operación."),
        sourceTool: z.string().max(120).optional(),
        executionRef: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId, stepId, note, artifactIds, sourceProvider, sourceTool, executionRef }) => {
      const result = await service.verifyStep(questId, stepId, { note, artifactIds, sourceProvider, sourceTool, executionRef });
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

  // -------------------------------------------------------------------------
  // FOCO Y CICLO DE VIDA DEL BORRADOR
  // -------------------------------------------------------------------------

  server.registerTool(
    "focus_quest",
    {
      title: "Poner una Quest en foco",
      description:
        "Cambia la Quest que el jugador mira ahora. Sólo mueve `focusedQuestId`: NO la acepta, NO la inicia y NO toca `engagedQuestId` ni ninguna Battle. Crear un borrador nunca enfoca solo; para mirarlo hay que llamar aquí. Usa null para soltar el foco. BACKLOG NO ES FOCO.",
      inputSchema: { questId: z.string().uuid().nullable().describe("Quest a enfocar, o null para soltar el foco.") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId }) => {
      const snapshot = await service.focusQuest(questId);
      return toolResult(
        snapshot.focusedQuest ? `Quest en foco: «${snapshot.focusedQuest.title}». No se inició ninguna batalla.` : "El reino quedó sin Quest en foco.",
        { focusedQuest: snapshot.focusedQuest, engagedQuest: snapshot.engagedQuest, hierarchy: snapshot.hierarchy },
      );
    },
  );

  server.registerTool(
    "focus_act",
    {
      title: "Poner un Acto en foco",
      description:
        "Cambia el Acto que el jugador mira. Navegación pura: los Actos de una misma Campaña son PARALELOS por defecto y enfocar uno no bloquea, cierra ni desbloquea a los demás. Usa null para soltar el foco.",
      inputSchema: { actId: z.string().uuid().nullable() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ actId }) => {
      const snapshot = await service.focusAct(actId);
      return toolResult(
        snapshot.hierarchy.focusedActId ? "Acto en foco actualizado." : "El reino quedó sin Acto en foco.",
        { hierarchy: snapshot.hierarchy },
      );
    },
  );

  server.registerTool(
    "delete_quest_draft",
    {
      title: "Eliminar un borrador de Quest",
      description:
        "Borra de raíz un borrador que el jugador NUNCA aceptó y que no tiene evidencia validada. Sirve para limpiar drafts irrelevantes sin borrar historia real. Una Quest aceptada, iniciada o completada NO se borra: para eso está abandon_quest, y lo completado es inmutable.",
      inputSchema: { questId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ questId }) => {
      await service.deleteQuestDraft(questId);
      return toolResult("Borrador eliminado. Ningún estado real fue tocado.", { questId, deleted: true });
    },
  );

  server.registerTool(
    "discard_quest",
    {
      title: "Descartar una misión",
      description:
        "El otro lado de JUGAR. No toda oportunidad detectada hay que jugarla: esto saca la misión de los asuntos pendientes y JUBILA todos sus avisos, para que deje de reclamar atención. El Core elige la vía honesta: un borrador nunca sellado y sin evidencia validada se borra de raíz; cualquier cosa con historia —sellada, iniciada, con evidencia— se abandona y su registro se conserva. Una Quest completada NO se descarta: su historia es inmutable.",
      inputSchema: {
        questId: z.string().uuid(),
        reason: z.string().min(3).max(300).describe("Por qué el jugador no la quiere. Queda en el registro."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ questId, reason }) => {
      const result = await service.discardQuest(questId, reason);
      return toolResult(
        result.outcome === "deleted"
          ? `«${result.title}» era un borrador sin historia: se eliminó de raíz con sus avisos.`
          : `«${result.title}» queda abandonada. Su historia se conserva y sus avisos dejaron de estar activos.`,
        result,
      );
    },
  );

  // -------------------------------------------------------------------------
  // CENTRO DE NOTIFICACIONES
  //
  // A PUSH IS A KNOCK ON THE GATE. THE NOTIFICATION CENTER IS THE RECORD.
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_notifications",
    {
      title: "Listar el Centro de Notificaciones",
      description:
        "Devuelve las notificaciones ACTIVAS del jugador: pactos que aguardan sello, frentes bloqueados, replanes disponibles, obligaciones vencidas. UN AVISO ACTIVO ES UNA COSA QUE TODAVÍA PIDE ALGO: al ganar, abandonar o completar una Quest, todos los suyos se jubilan solos y dejan de salir aquí. Cada uno lleva un deep link por entityId exacto, nunca por título. Con `includeArchived` se ve además el historial ya jubilado. Una push perdida NO borra su notificación.",
      inputSchema: {
        unreadOnly: z.boolean().optional().describe("Sólo las no leídas."),
        limit: z.number().int().min(1).max(200).optional(),
        entityType: notificationEntityType.optional(),
        includeArchived: z.boolean().optional().describe("Incluye el historial jubilado. Por defecto sólo lo que sigue pendiente."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ unreadOnly, limit, entityType, includeArchived }) => {
      const { notifications, unread } = await service.getNotifications({ unreadOnly, limit, includeArchived, entityType: entityType as NotificationEntityType | undefined });
      return toolResult(`${unread} sin leer · ${notifications.length} en la vista.`, { notifications, unread });
    },
  );

  server.registerTool(
    "resend_notification",
    {
      title: "Reenviar una notificación a este dispositivo",
      description:
        "Abre un intento de entrega NUEVO sobre una notificación existente. NO recrea la Quest, NO emite otro domain event y NO crea un segundo NotificationRecord: sólo un nuevo delivery attempt cuyo estado queda registrado.",
      inputSchema: { notificationId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ notificationId }) => {
      const record = await service.resendNotification(notificationId);
      return toolResult(`Reenvío intento ${record.push.attempts} para «${record.title}» (${record.push.lastStatus}).`, { notification: record });
    },
  );

  server.registerTool(
    "resend_entity_notification",
    {
      title: "Reenviar la notificación de una entidad",
      description:
        "Como resend_notification pero se localiza por entidad: entityType + entityId (+ notificationType opcional). Si no existe ninguna notificación para esa entidad NO se crea una: reenviar nunca fabrica un registro.",
      inputSchema: {
        entityType: notificationEntityType,
        entityId: z.string().uuid(),
        notificationType: notificationType.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ entityType, entityId, notificationType: type }) => {
      const record = await service.resendEntityNotification({
        entityType: entityType as NotificationEntityType,
        entityId,
        notificationType: type as NotificationType | undefined,
      });
      return toolResult(`Reenvío intento ${record.push.attempts} para «${record.title}».`, { notification: record });
    },
  );

  server.registerTool(
    "mark_notification_read",
    {
      title: "Marcar una notificación como leída",
      description:
        "Marca `readAt`. Ocurre también sola cuando el jugador abre el deep link. NO borra: el registro sigue en el Centro como historia.",
      inputSchema: { notificationId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ notificationId }) => {
      const record = await service.markNotificationRead(notificationId);
      return toolResult(`«${record.title}» quedó marcada como leída.`, { notification: record });
    },
  );

  server.registerTool(
    "archive_notification",
    {
      title: "Archivar una notificación",
      description: "Saca la notificación del Centro sin eliminar la historia. Reversible sólo por el servidor; el registro sigue existiendo.",
      inputSchema: { notificationId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ notificationId }) => {
      const record = await service.archiveNotification(notificationId);
      return toolResult(`«${record.title}» archivada.`, { notification: record });
    },
  );

  // -------------------------------------------------------------------------
  // TESORERÍA VIVA
  //
  // REAL MONEY IS NOT GAME CURRENCY. El monto SIEMPRE es explícito: nunca el
  // `impact` de una Quest.
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_recurring_obligation",
    {
      title: "Registrar una obligación recurrente",
      description:
        "Crea un gasto o ingreso recurrente real (arriendo, Claro, suscripción, cuota, salario…). El monto y la fecha pueden ser desconocidos al inicio y completarse luego con evidencia real. Cerca del vencimiento Torreón PROPONE una Quick Battle; nunca la inicia solo.",
      inputSchema: {
        name: z.string().min(2).max(120),
        direction: z.enum(["expense", "income"]),
        category: z.string().max(60).optional().describe("housing, utilities, subscription, salary, fees…"),
        frequency: z.enum(["weekly", "biweekly", "monthly", "bimonthly", "quarterly", "yearly"]),
        expectedAmount: z.number().min(0).nullable().optional().describe("COP. null u omitido si aún no se conoce."),
        provider: z.string().max(120).optional(),
        dueRule: dueRuleSchema.optional(),
        autoProposeBattle: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const obligation = await service.createRecurringObligation(args);
      return toolResult(`Obligación «${obligation.name}» registrada (${obligation.frequency}).`, { obligation });
    },
  );

  server.registerTool(
    "update_recurring_obligation",
    {
      title: "Actualizar una obligación recurrente",
      description: "Completa o corrige monto, proveedor, regla de vencimiento, frecuencia o estado activo de una obligación ya registrada.",
      inputSchema: {
        obligationId: z.string().uuid(),
        name: z.string().min(2).max(120).optional(),
        expectedAmount: z.number().min(0).nullable().optional(),
        provider: z.string().max(120).optional(),
        category: z.string().max(60).optional(),
        frequency: z.enum(["weekly", "biweekly", "monthly", "bimonthly", "quarterly", "yearly"]).optional(),
        dueRule: dueRuleSchema.optional(),
        active: z.boolean().optional(),
        autoProposeBattle: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ obligationId, ...patch }) => {
      const obligation = await service.updateRecurringObligation(obligationId, patch);
      return toolResult(`«${obligation.name}» actualizada.`, { obligation });
    },
  );

  server.registerTool(
    "get_financial_obligations",
    {
      title: "Ver la Tesorería y sus obligaciones",
      description:
        "Devuelve las obligaciones recurrentes con el estado del PERÍODO en curso (pagado / pendiente / próximo) más el balance observado, ingresos esperados y gastos comprometidos. Septiembre puede estar pagado y octubre pendiente sobre la misma obligación.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const { obligations, treasury } = await service.getFinancialObligations();
      return toolResult(`${obligations.filter((o) => o.periodStatus === "pending").length} obligación(es) con período pendiente.`, { obligations, treasury });
    },
  );

  server.registerTool(
    "record_financial_transaction",
    {
      title: "Registrar un movimiento financiero validado",
      description:
        "Registra un pago o ingreso REAL y confirmado. El monto es OBLIGATORIO y explícito: nunca se infiere del impacto de la Quest. Si se cita `recurringObligationId` se marca pagado el período en curso (no «para siempre») y se recalcula el próximo vencimiento. Idempotente por evidencia: la misma prueba sobre el mismo período no crea dos movimientos.",
      inputSchema: {
        direction: z.enum(["expense", "income"]),
        amount: z.number().positive().describe("Monto real en COP. Obligatorio."),
        occurredAt: z.string().max(40).optional().describe("ISO. Por defecto ahora."),
        recurringObligationId: z.string().uuid().optional(),
        questId: z.string().uuid().optional(),
        evidenceArtifactId: z.string().uuid().optional(),
        note: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await service.recordFinancialTransaction(args);
      return toolResult(
        result.duplicate
          ? "Esa evidencia ya había registrado el movimiento de este período: no se duplicó."
          : `Movimiento de ${result.transaction.amount.toLocaleString("es-CO")} COP registrado${result.obligation ? ` para «${result.obligation.name}»` : ""}.`,
        result,
      );
    },
  );

  // -------------------------------------------------------------------------
  // BARRACAS Y MEMORIA DE BATALLA
  //
  // AN AGENT IS A HERO ONLY WHEN IT ACTUALLY PARTICIPATES.
  // THE PARTY REMEMBERS WHAT IT HAS DONE.
  // THE GAME LEARNS HOW LONG REAL WORK ACTUALLY TAKES.
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_barracks",
    {
      title: "Abrir las Barracas",
      description:
        "Lee el grupo (Roku, Marqués, Cordera) y los agentes (Opus, Claude, Codex, Gemini) con su carrera REAL: nivel, XP, estadísticas, maestrías explicables y hazañas verificadas. Un agente que nunca ejecutó nada aparece conocido y con todos sus contadores en cero: no se le inventan estadísticas ni hazañas. El nivel es gameplay y NO concede ningún permiso: enviar, firmar, pagar, borrar o desplegar siguen exigiendo confirmación humana sea cual sea el nivel.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const barracks = await service.barracks();
      const veterans = barracks.heroes.filter((hero) => hero.kind === "agent" && hero.stats.executions > 0);
      const resumen =
        veterans.length > 0
          ? `Agentes con historia real: ${veterans.map((hero) => `${hero.displayName} (nv ${hero.level}, ${hero.stats.validatedAssists} assist validados)`).join(", ")}.`
          : "Ningún agente ha ejecutado todavía nada real: el cuarto slot sigue vacío.";
      return toolResult(resumen, { barracks });
    },
  );

  server.registerTool(
    "set_hero_availability",
    {
      title: "Declarar la disponibilidad de un aliado",
      description:
        "Marca si un compañero está conectado, disponible o no disponible ahora mismo. Disponible NO es desplegado y NO es haber participado. Si un conector deja de existir, esto NO borra al héroe ni su historia: sólo lo marca como no disponible conservando su último despliegue.",
      inputSchema: {
        heroId: z.enum(["roko", "marques", "cordera", "opus", "codex", "claude", "gemini"]),
        availability: z.enum(["connected", "available", "unavailable", "unknown"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ heroId, availability }) => {
      const barracks = await service.setHeroAvailability(heroId, availability);
      return toolResult(`Disponibilidad de ${heroId} declarada como ${availability}. Su historia queda intacta.`, { barracks });
    },
  );

  server.registerTool(
    "get_battle_memory",
    {
      title: "Consultar lo que el reino aprendió",
      description:
        "Duraciones reales frente a las pactadas, lecciones concretas y playbooks de batallas repetidas. Consúltalo ANTES de proponer un plazo: si un trabajo así tomó 47 minutos de mediana, no vuelvas a proponer 20 sin una razón. Esto NO cambia ningún contrato ya aceptado.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const memory = await service.battleMemory();
      const drift = memory.durations.filter((entry) => entry.driftRatio > 1.2);
      const resumen =
        drift.length > 0
          ? `El reino subestima ${drift.length} tipo(s) de trabajo. Ej.: «${drift[0].title}» se planea en ${drift[0].plannedMedianMinutes} min y toma ${drift[0].actualMedianMinutes}.`
          : `${memory.reports.length} informe(s) de acción registrados.`;
      return toolResult(resumen, { memory });
    },
  );

  server.registerTool(
    "get_planning_hint",
    {
      title: "Pedir memoria antes de planear",
      description:
        "Dada una intención NUEVA, devuelve lo que el reino ya sabe de un trabajo parecido: duración real mediana, lecciones aprendidas, playbook y compañeros que funcionaron. Úsalo al planear; nunca para repactar en silencio un contrato vivo, porque cambiar un pacto aceptado exige un amendment sellado por el jugador. Reconocer un playbook tampoco lo acepta ni lo inicia: pregunta primero.",
      inputSchema: { intent: z.string().min(4).max(500) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ intent }) => {
      const hint = await service.planningHint(intent);
      const resumen = hint.suggestedDurationMinutes
        ? `Historial de ${hint.samples} batalla(s) parecida(s): mediana real ${hint.suggestedDurationMinutes} min (se planearon ${hint.plannedMedianMinutes}).`
        : "El reino todavía no tiene historia de un trabajo parecido: estima con lo que sepas y luego aprenderá.";
      return toolResult(resumen, { hint });
    },
  );

  server.registerTool(
    "get_after_action_report",
    {
      title: "Leer el informe de acción de una Battle",
      description:
        "Informe determinista de una Battle ganada: duración real frente a la pactada, replanes, exigencias imprevistas, herramientas, compañeros y lecciones. Se genera desde los hechos, no desde un relato.",
      inputSchema: { questId: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ questId }) => {
      const report = await service.afterActionReport(questId);
      return toolResult(
        report
          ? `«${report.questTitle}»: ${Math.round(report.actualActiveMs / 60_000)} min activos frente a ${report.plannedDurationMinutes} pactados, ${report.replans} replan(es).`
          : "Esta Quest todavía no tiene informe de acción: sólo lo genera una victoria.",
        { report },
      );
    },
  );

  server.registerTool(
    "invalidate_event",
    {
      title: "Anular un hecho registrado por error",
      description:
        "Marca como inválido un hecho registrado por un error OPERATIVO —por ejemplo un unexpected_requirement que no correspondía a ninguna exigencia real—. NO borra nada: la auditoría lo conserva con quién lo anuló y por qué, y las proyecciones de gameplay dejan de contarlo. Si ese hecho había golpeado al grupo, el daño se devuelve con exactitud. Nunca la uses para deshacer historia real: la evidencia validada, el impacto y el dinero no se anulan desde aquí.",
      inputSchema: {
        eventId: z.string().uuid().describe("Id del LifeEvent o GameEvent registrado por error."),
        reason: z.string().min(10).max(300).describe("Por qué fue un error operativo y no un hecho real."),
        invalidatedBy: z.string().max(60).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await service.invalidateEvent(args);
      return toolResult(result.message, result);
    },
  );

  return server;
}
