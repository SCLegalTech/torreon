import { randomUUID } from "node:crypto";
import { ingestArtifact, witnessArtifact, type ArtifactInput, type WitnessInput } from "./artifacts.js";
import { HeuristicCodice, questFromIntent, validatePlan, type CodicePlanner, type Judgement } from "./codice.js";
import type {
  BattleState,
  EvidenceArtifact,
  EvidenceSource,
  EvidenceVerdict,
  Quest,
  QuestDetail,
  QuestPlanInput,
  QuestStep,
  RealmEvent,
  RealmSnapshot,
  RealmState,
} from "./domain.js";
import { consistencyFor, currentStepFor, progressFor, questDetailFor } from "./read-models.js";
import { JsonRealmStore } from "./store.js";

export { questFromIntent } from "./codice.js";

const now = () => new Date().toISOString();

function requireQuest(state: RealmState, questId: string): Quest {
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest) throw new Error(`Quest no encontrada: ${questId}`);
  return quest;
}

function addEvent(state: RealmState, event: Omit<RealmEvent, "id" | "createdAt">): void {
  state.events.unshift({ id: randomUUID(), createdAt: now(), ...event });
  state.events = state.events.slice(0, 100);
}

export function battleFor(quest: Quest | null): BattleState | null {
  if (!quest) return null;
  const damage = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  const completedSteps = quest.steps.filter((step) => step.status === "completed").length;
  return {
    questId: quest.id,
    enemyMaxHealth: 100,
    enemyHealth: Math.max(0, 100 - damage),
    progress: Math.min(100, damage),
    completedSteps,
    totalSteps: quest.steps.length,
    isKo: damage === 100,
  };
}

/** Pasos cuya condición pactada exige una prueba, no un relato. */
const ARTIFACT_KINDS = new Set(["file", "link", "screenshot"]);

/**
 * El servidor —no el modelo— decide si un veredicto es admisible.
 * Si el paso pactó una prueba y no llegó ninguna comprobada, ningún juez puede
 * dar el paso por cerrado, por convincente que suene la declaración.
 */
export function enforceArtifactRule(
  judgement: Judgement,
  step: QuestStep,
  artifacts: EvidenceArtifact[],
  remainingImpact: number,
): Judgement {
  if (judgement.verdict !== "accepted") return judgement;
  if (!step.evidenceKind || !ARTIFACT_KINDS.has(step.evidenceKind)) return judgement;
  if (artifacts.some((artifact) => artifact.verification.verified)) return judgement;

  const nota = `Este paso pactó una prueba (${step.evidenceKind}) y no llegó ninguna que el servidor pudiera comprobar, así que no puede cerrarse con una declaración.`;
  if (remainingImpact <= 1) {
    return { verdict: "rejected", impactAwarded: 0, reasoning: `${judgement.reasoning} ${nota}` };
  }
  return {
    verdict: "partial",
    impactAwarded: Math.max(1, Math.floor(remainingImpact / 2)),
    reasoning: `${judgement.reasoning} ${nota}`,
  };
}

function currentQuest(state: RealmState): Quest | null {
  return (
    state.quests.find((quest) => quest.status === "active") ??
    state.quests.find((quest) => quest.status === "accepted") ??
    state.quests.find((quest) => quest.status === "draft") ??
    state.quests[0] ??
    null
  );
}

export interface CodiceVerdictResult {
  quest: Quest;
  battle: BattleState;
  evidenceId: string;
  lifeEventId: string;
  gameEventId: string | null;
  judgement: Judgement;
  artifacts: EvidenceArtifact[];
}

export class QuestService {
  constructor(
    private readonly store: JsonRealmStore,
    private readonly codice: CodicePlanner = new HeuristicCodice(),
    private readonly dataDir = "./data",
    /** Etiqueta legible de esta instancia: distingue el reino local del de la nube. */
    private readonly instance = process.env.TORREON_INSTANCE?.trim() || "torreon-local",
  ) {}

  get codiceName(): string {
    return this.codice.name;
  }

  async snapshot(): Promise<RealmSnapshot> {
    const realm = await this.store.read();
    const quest = currentQuest(realm);
    const { availableBalance, expectedIncome, committedExpenses, reserveTarget } = realm.financial;
    return {
      realm,
      currentQuest: quest,
      progress: progressFor(quest),
      currentStep: currentStepFor(quest),
      battle: battleFor(quest),
      consistency: consistencyFor(realm, this.instance, quest),
      projectedMargin: availableBalance + expectedIncome - committedExpenses - reserveTarget,
    };
  }

  /**
   * Lectura detallada de una misión: pasos, artefactos y veredictos unidos.
   * Responde «¿qué ocurre exactamente dentro de esta misión?», que es distinto
   * de la panorámica que da snapshot().
   */
  async questDetail(questId: string): Promise<QuestDetail> {
    return questDetailFor(await this.store.read(), questId);
  }

  async createDraft(plan: QuestPlanInput): Promise<Quest> {
    validatePlan(plan);
    const { result } = await this.store.mutate((state) => {
      const conflicting = state.quests.find((quest) => ["accepted", "active"].includes(quest.status));
      if (conflicting) throw new Error(`Ya existe una quest ${conflicting.status}: ${conflicting.title}`);
      const timestamp = now();
      const quest: Quest = {
        ...plan,
        id: randomUUID(),
        status: "draft",
        steps: plan.steps.map((step) => ({
          ...step,
          id: randomUUID(),
          status: "pending",
          impactAwarded: 0,
          evidenceIds: [],
          artifactIds: [],
        })),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.quests.unshift(quest);
      addEvent(state, { type: "quest_created", questId: quest.id, message: `El Códice redactó «${quest.title}».` });
      return quest;
    });
    return result;
  }

  /**
   * Cualquier objetivo, en cualquier dominio, entra por aquí. El Códice activo
   * decide la descomposición; el servidor solo valida que el contrato sea jugable.
   */
  async createDraftFromIntent(intent: string, minutesAvailable?: number): Promise<Quest> {
    const clean = intent.trim();
    if (clean.length < 8) throw new Error("Describe una quest con un poco más de detalle.");
    const realm = await this.store.read();
    const plan = await this.codice.plan({
      intent: clean,
      playerTitle: `${realm.player.displayName}, ${realm.player.title}`,
      activeCampaign: realm.quests.find((quest) => quest.status === "active")?.campaignTitle,
      minutesAvailable,
    });
    return this.createDraft(plan);
  }

  async reviseDraft(questId: string, plan: QuestPlanInput): Promise<Quest> {
    validatePlan(plan);
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft") throw new Error("Solo se puede reformular una quest en borrador.");
      Object.assign(quest, plan, {
        steps: plan.steps.map((step) => ({ ...step, id: randomUUID(), status: "pending" as const, impactAwarded: 0, evidenceIds: [], artifactIds: [] })),
        updatedAt: now(),
      });
      addEvent(state, { type: "quest_revised", questId, message: `El contrato de «${quest.title}» fue reformulado.` });
      return quest;
    });
    return result;
  }

  async accept(questId: string, userAccepted: boolean): Promise<Quest> {
    if (!userAccepted) throw new Error("La aceptación explícita del usuario es obligatoria.");
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "draft") throw new Error("Solo se puede aceptar una quest en borrador.");
      quest.status = "accepted";
      quest.acceptedAt = now();
      quest.updatedAt = quest.acceptedAt;
      addEvent(state, { type: "quest_accepted", questId, message: `El marqués aceptó «${quest.title}».` });
      return quest;
    });
    return result;
  }

  async start(questId: string): Promise<Quest> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "accepted") throw new Error("La quest debe estar aceptada antes de comenzar.");
      quest.status = "active";
      quest.startedAt = now();
      quest.updatedAt = quest.startedAt;
      addEvent(state, { type: "quest_started", questId, message: `Comienza la batalla: «${quest.title}».` });
      return quest;
    });
    return result;
  }

  async submitEvidence(
    questId: string,
    stepId: string,
    input: {
      summary: string;
      source: EvidenceSource;
      verdict: EvidenceVerdict;
      reasoning: string;
      impactAwarded: number;
      artifactIds?: string[];
    },
  ): Promise<{ quest: Quest; battle: BattleState; evidenceId: string; lifeEventId: string; gameEventId: string | null }> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (quest.status !== "active") throw new Error("La quest debe estar activa para evaluar evidencia.");
      const step = quest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
      if (step.status === "completed") throw new Error("Este paso ya recibió todo su impacto.");
      if (!input.summary.trim()) throw new Error("Describe brevemente la evidencia aportada.");
      if (!input.reasoning.trim()) throw new Error("Códice debe explicar el veredicto.");
      const remaining = step.weight - step.impactAwarded;
      if (!Number.isInteger(input.impactAwarded) || input.impactAwarded < 0 || input.impactAwarded > remaining) {
        throw new Error(`El impacto debe ser un entero entre 0 y ${remaining}.`);
      }
      if (input.verdict === "rejected" && input.impactAwarded !== 0) {
        throw new Error("La evidencia rechazada no puede causar daño.");
      }
      if (input.verdict === "partial" && (input.impactAwarded <= 0 || input.impactAwarded >= remaining)) {
        throw new Error("La evidencia parcial debe conceder parte, pero no todo, del impacto restante.");
      }
      if (input.verdict === "accepted" && input.impactAwarded !== remaining) {
        throw new Error("La evidencia aceptada debe conceder todo el impacto restante.");
      }

      const timestamp = now();
      const evidenceId = randomUUID();
      const artifactIds = (input.artifactIds ?? []).filter((id) => state.artifacts.some((artifact) => artifact.id === id));
      state.evidence.unshift({ id: evidenceId, questId, stepId, summary: input.summary.trim(), source: input.source, verdict: input.verdict, reasoning: input.reasoning.trim(), impactAwarded: input.impactAwarded, artifactIds, createdAt: timestamp });
      state.evidence = state.evidence.slice(0, 200);

      const lifeEventId = randomUUID();
      state.lifeEvents.unshift({ id: lifeEventId, type: "evidence_submitted", questId, stepId, evidenceId, verdict: input.verdict, impactAwarded: input.impactAwarded, createdAt: timestamp });
      state.lifeEvents = state.lifeEvents.slice(0, 200);

      step.evidenceIds.push(evidenceId);
      step.evidenceNote = input.summary.trim();
      step.impactAwarded += input.impactAwarded;
      step.status = step.impactAwarded === step.weight ? "completed" : step.impactAwarded > 0 ? "in_progress" : "pending";
      if (step.status === "completed") step.completedAt = timestamp;
      quest.updatedAt = timestamp;

      let gameEventId: string | null = null;
      if (input.impactAwarded > 0) {
        gameEventId = randomUUID();
        state.gameEvents.unshift({ id: gameEventId, type: "quest_attack", sourceLifeEventId: lifeEventId, questId, stepId, damage: input.impactAwarded, message: `${step.title}: ataque de ${input.impactAwarded}.`, createdAt: timestamp });
        state.gameEvents = state.gameEvents.slice(0, 200);
      }
      addEvent(state, {
        type: "step_completed",
        questId,
        message: input.impactAwarded > 0 ? `${step.title}: impacto validado de ${input.impactAwarded} puntos.` : `${step.title}: evidencia rechazada; sin impacto.`,
      });
      const battle = battleFor(quest)!;
      if (battle.isKo) {
        quest.status = "completed";
        quest.completedAt = now();
        quest.updatedAt = quest.completedAt;
        addEvent(state, { type: "quest_completed", questId, message: `KO: «${quest.title}» fue completada.` });
      }
      return { quest, battle, evidenceId, lifeEventId, gameEventId };
    });
    return result;
  }

  /**
   * Entrega un hecho real al MCP: un documento, un enlace o un texto.
   * El servidor comprueba lo comprobable y lo guarda en el reino. Todavía no
   * causa daño: un artefacto es materia prima de un veredicto, no el veredicto.
   */
  async attachArtifact(questId: string, stepId: string, input: ArtifactInput): Promise<EvidenceArtifact> {
    const state = await this.store.read();
    const quest = requireQuest(state, questId);
    if (["completed", "abandoned"].includes(quest.status)) {
      throw new Error("Esta quest ya no admite evidencia.");
    }
    if (!quest.steps.some((step) => step.id === stepId)) throw new Error(`Paso no encontrado: ${stepId}`);

    const artifact = await ingestArtifact(input, questId, stepId, this.dataDir);

    const { result } = await this.store.mutate((fresh) => {
      const freshQuest = requireQuest(fresh, questId);
      const step = freshQuest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
      fresh.artifacts.unshift(artifact);
      fresh.artifacts = fresh.artifacts.slice(0, 200);
      step.artifactIds.push(artifact.id);
      freshQuest.updatedAt = now();
      addEvent(fresh, {
        type: "evidence_attached",
        questId,
        message: `${step.title}: llegó ${artifact.label}${artifact.verification.verified ? " (comprobado)" : " (sin comprobar)"}.`,
      });
      return artifact;
    });
    return result;
  }

  /**
   * Registra un artefacto que el Dungeon Master examinó donde vive el archivo.
   * Permite jugar sin tocar el teléfono: la prueba nunca pasa por el juego.
   */
  async attestArtifact(questId: string, stepId: string, input: WitnessInput): Promise<EvidenceArtifact> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (["completed", "abandoned"].includes(quest.status)) {
        throw new Error("Esta quest ya no admite evidencia.");
      }
      const step = quest.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Paso no encontrado: ${stepId}`);

      const artifact = witnessArtifact(input, questId, stepId);
      state.artifacts.unshift(artifact);
      state.artifacts = state.artifacts.slice(0, 200);
      step.artifactIds.push(artifact.id);
      quest.updatedAt = now();
      addEvent(state, {
        type: "evidence_attached",
        questId,
        message: `${step.title}: ${artifact.verification.witness} examinó ${artifact.label}.`,
      });
      return artifact;
    });
    return result;
  }

  /**
   * Cierra el bucle: Códice juzga la evidencia del paso y el veredicto se
   * convierte en LifeEvent y, solo si hay impacto, en el ataque de la batalla.
   */
  async verifyStep(
    questId: string,
    stepId: string,
    input: { note?: string; artifactIds?: string[]; attach?: ArtifactInput },
  ): Promise<CodiceVerdictResult> {
    if (input.attach) await this.attachArtifact(questId, stepId, input.attach);

    const state = await this.store.read();
    const quest = requireQuest(state, questId);
    if (quest.status !== "active") throw new Error("La quest debe estar activa para evaluar evidencia.");
    const step: QuestStep | undefined = quest.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
    if (step.status === "completed") throw new Error("Este paso ya recibió todo su impacto.");

    const wanted = input.artifactIds?.length ? new Set(input.artifactIds) : new Set(step.artifactIds);
    const artifacts = state.artifacts.filter((artifact) => artifact.stepId === stepId && wanted.has(artifact.id));
    const note = (input.note ?? "").trim();
    if (!note && artifacts.length === 0) {
      throw new Error("Entrega un artefacto o describe la evidencia antes de pedir el veredicto.");
    }

    const remainingImpact = step.weight - step.impactAwarded;
    const raw = await this.codice.judge({ quest, step, remainingImpact, note, artifacts });
    const judgement = enforceArtifactRule(raw, step, artifacts, remainingImpact);
    const source: EvidenceSource = artifacts.some((artifact) => artifact.kind === "file")
      ? "file"
      : artifacts.length > 0
        ? "mcp"
        : "user_declaration";

    const applied = await this.submitEvidence(questId, stepId, {
      summary: note || artifacts.map((artifact) => artifact.label).join(", "),
      source,
      verdict: judgement.verdict,
      reasoning: judgement.reasoning,
      impactAwarded: judgement.impactAwarded,
      artifactIds: artifacts.map((artifact) => artifact.id),
    });

    return { ...applied, judgement, artifacts };
  }

  async completeStep(questId: string, stepId: string, evidenceNote: string): Promise<{ quest: Quest; battle: BattleState }> {
    const snapshot = await this.snapshot();
    const step = snapshot.realm.quests.find((quest) => quest.id === questId)?.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new Error(`Paso no encontrado: ${stepId}`);
    const result = await this.submitEvidence(questId, stepId, {
      summary: evidenceNote,
      source: "user_declaration",
      verdict: "accepted",
      reasoning: "Compatibilidad del MVP: evidencia declarada como suficiente.",
      impactAwarded: step.weight - step.impactAwarded,
    });
    return { quest: result.quest, battle: result.battle };
  }

  async abandon(questId: string, reason: string): Promise<Quest> {
    const { result } = await this.store.mutate((state) => {
      const quest = requireQuest(state, questId);
      if (!["draft", "accepted", "active"].includes(quest.status)) {
        throw new Error("Esta quest ya no puede abandonarse.");
      }
      quest.status = "abandoned";
      quest.abandonedAt = now();
      quest.updatedAt = quest.abandonedAt;
      addEvent(state, { type: "quest_abandoned", questId, message: `Retirada: ${reason.trim() || "sin motivo registrado"}.` });
      return quest;
    });
    return result;
  }

  async reset(): Promise<RealmSnapshot> {
    await this.store.reset();
    return this.snapshot();
  }
}

export const demoQuest: QuestPlanInput = {
  campaignTitle: "Segundo estandarte",
  title: "Cinco puertas",
  intent: "Avanzar hacia un segundo trabajo compatible con mi perfil y bienestar.",
  outcome: "Enviar cinco candidaturas verificables a vacantes de alta compatibilidad.",
  rationale: "Prioriza vacantes relevantes y convierte una intención amplia en resultados comprobables.",
  durationMinutes: 60,
  wellbeingConstraints: ["Preferencia remota o híbrida", "Horario compatible con la actividad principal"],
  allowedApps: ["Gmail", "Google Drive", "LinkedIn", "Navegador"],
  steps: [
    { title: "Definir la guardia", description: "Confirmar salario, horario y modalidad aceptables.", actor: "shared", evidence: "Criterios registrados", weight: 10 },
    { title: "Revelar las puertas", description: "Localizar y escoger cinco vacantes compatibles.", actor: "codex", evidence: "Cinco enlaces vigentes", weight: 15 },
    { title: "Templar el acero", description: "Adaptar la hoja de vida al grupo de vacantes.", actor: "shared", evidence: "Versión final del CV", weight: 20 },
    { title: "Preparar los estandartes", description: "Redactar mensajes y respuestas requeridas.", actor: "shared", evidence: "Textos listos para revisión", weight: 15 },
    { title: "Cruzar las cinco puertas", description: "Enviar las cinco candidaturas.", actor: "user", evidence: "Confirmaciones de envío", weight: 40 },
  ],
};
