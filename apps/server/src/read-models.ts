import type {
  Act,
  ActView,
  BattleState,
  Campaign,
  CampaignView,
  CharacterStats,
  CurrentStepSummary,
  EvidenceArtifact,
  EvidenceRecord,
  Quest,
  QuestDetail,
  QuestNode,
  QuestProgress,
  RealmConsistency,
  RealmHierarchy,
  RealmState,
  SagaView,
} from "./domain.js";

/**
 * Modelos de lectura para el Dungeon Master.
 *
 * `get_realm_state` responde «¿qué ocurre en mi reino?».
 * `get_quest_detail` responde «¿qué ocurre exactamente dentro de esta misión?».
 *
 * Nada de esto es estado nuevo: todo se deriva en el momento de la lectura del
 * mismo archivo del reino, así que no puede quedar desincronizado de la verdad.
 */

export function progressFor(quest: Quest | null): QuestProgress | null {
  if (!quest) return null;
  const validatedImpact = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  return {
    questId: quest.id,
    validatedImpact,
    remainingImpact: Math.max(0, 100 - validatedImpact),
    percent: Math.min(100, validatedImpact),
    completedSteps: quest.steps.filter((step) => step.status === "completed").length,
    totalSteps: quest.steps.length,
  };
}

/**
 * El paso accionable es el primero que todavía no cobró todo su impacto.
 * No se guarda: se deriva, para que no exista un puntero que pueda mentir.
 */
export function currentStepFor(quest: Quest | null): CurrentStepSummary | null {
  if (!quest || !["accepted", "active"].includes(quest.status)) return null;
  const index = quest.steps.findIndex((step) => ["pending", "in_progress"].includes(step.status) && step.impactAwarded < step.weight);
  if (index === -1) return null;
  const step = quest.steps[index];
  return {
    id: step.id,
    position: index + 1,
    title: step.title,
    actor: step.actor,
    evidence: step.evidence,
    evidenceKind: step.evidenceKind,
    verificationHint: step.verificationHint,
    weight: step.weight,
    impactAwarded: step.impactAwarded,
    remainingImpact: step.weight - step.impactAwarded,
    status: step.status,
  };
}

/**
 * Hoja de personaje.
 *
 * HP es estado de combate del frente abierto, no salud médica: sin batalla el
 * Marqués está entero. XP y Aura son progresión concedida por resultados
 * validados. El Tesoro es el dinero real del reino y no lo mueve ninguna quest
 * por sí sola: completar una misión nunca fabrica monedas.
 */
export function statsFor(state: RealmState, battle: BattleState | null): CharacterStats {
  return {
    displayName: state.player.displayName,
    title: state.player.title,
    hp: battle?.playerHealth ?? 100,
    maxHp: battle?.playerMaxHealth ?? 100,
    xp: state.character.xp,
    aura: state.character.aura,
    mastery: Object.entries(state.character.mastery)
      .map(([domain, points]) => ({ domain, points }))
      .sort((a, b) => b.points - a.points),
    treasure: { currency: state.financial.currency, amount: state.financial.availableBalance },
  };
}

/**
 * Señal de consistencia.
 *
 * Solo reporta lo que puede comprobarse en los datos. No existe una proyección
 * separada que pueda quedar rancia —`currentQuest` se deriva en cada lectura—,
 * así que no se inventan códigos de desincronización que aquí no pueden ocurrir.
 *
 * El caso que sí importa: un reino vacío consultado por un Dungeon Master que
 * cree estar en campaña. Casi siempre significa que está hablando con OTRA
 * instancia de Torreón, no que el estado se haya perdido.
 */
export function consistencyFor(state: RealmState, instance: string, currentQuest: Quest | null): RealmConsistency {
  const issues: RealmConsistency["issues"] = [];

  const activeQuests = state.quests.filter((quest) => quest.status === "active");
  if (activeQuests.length > 1) {
    issues.push({
      code: "MULTIPLE_ACTIVE_QUESTS",
      entityId: activeQuests[0].id,
      message: `Hay ${activeQuests.length} quests activas y el MVP asume una sola.`,
    });
  }

  const stepIds = new Set(state.quests.flatMap((quest) => quest.steps.map((step) => step.id)));
  const orphanEvidence = state.evidence.filter((record: EvidenceRecord) => !stepIds.has(record.stepId));
  if (orphanEvidence.length > 0) {
    issues.push({
      code: "ORPHAN_EVIDENCE",
      entityId: orphanEvidence[0].id,
      message: `${orphanEvidence.length} evidencia(s) apuntan a pasos que ya no existen.`,
    });
  }

  const orphanArtifacts = state.artifacts.filter((artifact: EvidenceArtifact) => !artifact.stepIds.some((stepId) => stepIds.has(stepId)));
  if (orphanArtifacts.length > 0) {
    issues.push({
      code: "ORPHAN_ARTIFACT",
      entityId: orphanArtifacts[0].id,
      message: `${orphanArtifacts.length} artefacto(s) apuntan a pasos que ya no existen.`,
    });
  }

  if (state.quests.length === 0) {
    issues.push({
      code: "EMPTY_REALM",
      message:
        `Este reino («${instance}») no tiene ninguna quest registrada. Si el jugador afirma estar en una misión, ` +
        "lo más probable es que su campaña viva en otra instancia de Torreón —local frente a nube— y no que el estado se haya perdido. " +
        "Pregúntale con cuál está jugando antes de concluir que hubo un fallo.",
    });
  }

  return {
    status: issues.some((issue) => issue.code === "MULTIPLE_ACTIVE_QUESTS") ? "desynced" : issues.length > 0 ? "warning" : "ok",
    instance,
    realmId: state.realmId,
    activeQuestCount: activeQuests.length,
    currentQuestId: currentQuest?.id ?? null,
    issues,
  };
}

/** Une la quest con sus artefactos y veredictos, paso por paso. */
export function questDetailFor(state: RealmState, questId: string): QuestDetail {
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest) {
    const error = new Error(`Quest no encontrada: ${questId}`);
    (error as Error & { code?: string }).code = "QUEST_NOT_FOUND";
    throw error;
  }

  return {
    id: quest.id,
    campaignTitle: quest.campaignTitle,
    title: quest.title,
    intent: quest.intent,
    outcome: quest.outcome,
    rationale: quest.rationale,
    status: quest.status,
    durationMinutes: quest.durationMinutes,
    wellbeingConstraints: quest.wellbeingConstraints,
    allowedApps: quest.allowedApps,
    createdAt: quest.createdAt,
    acceptedAt: quest.acceptedAt,
    startedAt: quest.startedAt,
    completedAt: quest.completedAt,
    abandonedAt: quest.abandonedAt,
    version: quest.version,
    amendments: quest.amendments,
    progress: progressFor(quest)!,
    currentStep: currentStepFor(quest),
    steps: quest.steps.map((step, index) => ({
      id: step.id,
      position: index + 1,
      title: step.title,
      description: step.description,
      actor: step.actor,
      evidence: step.evidence,
      evidenceKind: step.evidenceKind,
      verificationHint: step.verificationHint,
      weight: step.weight,
      impactAwarded: step.impactAwarded,
      remainingImpact: step.weight - step.impactAwarded,
      status: step.status,
      blockedBy: step.blockedBy,
      blockedReason: step.blockedReason,
      blockedSince: step.blockedSince,
      playerActionAvailable: step.playerActionAvailable,
      followUpAfter: step.followUpAfter,
      supersededReason: step.supersededReason,
      artifacts: state.artifacts.filter((artifact) => artifact.stepIds.includes(step.id)),
      verdicts: state.evidence.filter((record) => record.stepId === step.id),
    })),
  };
}


// ---------------------------------------------------------------------------
// SAGA -> CAMPAÑA -> ACTO -> QUEST
//
// El progreso siempre se deriva de resultados reales: una Quest cuenta cuando
// su impacto validado llegó a 100, no cuando alguien la tocó. Y nada de esto se
// guarda: si se guardara, podría mentir.
// ---------------------------------------------------------------------------

const CLOSED_QUEST = new Set(["completed", "abandoned"]);

function questNodeFor(quest: Quest, position: number, locked: boolean, isBoss: boolean): QuestNode {
  const validatedImpact = quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0);
  return {
    id: quest.id,
    position,
    title: quest.title,
    outcome: quest.outcome,
    status: quest.status,
    durationMinutes: quest.durationMinutes,
    validatedImpact,
    percent: Math.min(100, validatedImpact),
    battleStatus: quest.battle?.status ?? "pending",
    locked,
    isBoss,
  };
}

function actViewFor(state: RealmState, act: Act, position: number, locked: boolean): ActView {
  const quests = act.questIds
    .map((questId) => state.quests.find((quest) => quest.id === questId))
    .filter((quest): quest is Quest => Boolean(quest));

  let previousDone = true;
  const nodes = quests.map((quest, index) => {
    // El camino se abre en orden: un nodo espera a que caiga el anterior.
    const node = questNodeFor(quest, index + 1, locked || !previousDone, index === quests.length - 1 && quests.length > 1);
    previousDone = quest.status === "completed";
    return node;
  });

  const completedQuests = quests.filter((quest) => quest.status === "completed").length;
  return {
    id: act.id,
    position,
    title: act.title,
    subtitle: act.subtitle,
    scenario: act.scenario,
    status: act.status,
    estimatedActiveMinutes: act.estimatedActiveMinutes,
    quests: nodes,
    completedQuests,
    totalQuests: nodes.length,
    percent: nodes.length > 0 ? Math.round((completedQuests / nodes.length) * 100) : 0,
    locked,
  };
}

function campaignViewFor(state: RealmState, campaign: Campaign): CampaignView {
  let previousDone = true;
  const acts = campaign.actIds
    .map((actId) => state.acts.find((act) => act.id === actId))
    .filter((act): act is Act => Boolean(act))
    .map((act, index) => {
      const view = actViewFor(state, act, index + 1, !previousDone);
      previousDone = act.status === "completed";
      return view;
    });

  const completedActs = acts.filter((act) => act.status === "completed").length;
  const totalQuests = acts.reduce((sum, act) => sum + act.totalQuests, 0);
  const completedQuests = acts.reduce((sum, act) => sum + act.completedQuests, 0);
  return {
    id: campaign.id,
    title: campaign.title,
    summary: campaign.summary,
    objective: campaign.objective,
    status: campaign.status,
    estimatedActiveMinutes: campaign.estimatedActiveMinutes,
    scenario: campaign.scenario,
    bossTitle: campaign.bossTitle,
    bossDescription: campaign.bossDescription,
    acts,
    completedActs,
    totalActs: acts.length,
    completedQuests,
    totalQuests,
    percent: totalQuests > 0 ? Math.round((completedQuests / totalQuests) * 100) : 0,
  };
}

function sagaViewFor(state: RealmState, campaigns: CampaignView[]): (saga: RealmState["sagas"][number]) => SagaView {
  return (saga) => {
    const own = campaigns.filter((campaign) => saga.campaignIds.includes(campaign.id));
    const completedCampaigns = own.filter((campaign) => campaign.status === "completed").length;
    return {
      id: saga.id,
      title: saga.title,
      summary: saga.summary,
      status: saga.status,
      campaignIds: saga.campaignIds,
      completedCampaigns,
      totalCampaigns: own.length,
      percent: own.length > 0 ? Math.round((completedCampaigns / own.length) * 100) : 0,
    };
  };
}

export function hierarchyFor(state: RealmState, currentQuest: Quest | null): RealmHierarchy {
  const campaigns = state.campaigns.map((campaign) => campaignViewFor(state, campaign));
  const sagas = state.sagas.map(sagaViewFor(state, campaigns));

  const act = currentQuest?.actId ? state.acts.find((candidate) => candidate.id === currentQuest.actId) ?? null : null;
  const campaign = act?.campaignId
    ? state.campaigns.find((candidate) => candidate.id === act.campaignId) ?? null
    : currentQuest?.campaignId
      ? state.campaigns.find((candidate) => candidate.id === currentQuest.campaignId) ?? null
      : null;

  // Microquests: sin Acto ni Campaña, y eso es legítimo. No se les fabrica padre.
  const standaloneQuests = state.quests
    .filter((quest) => !quest.actId && !CLOSED_QUEST.has(quest.status))
    .map((quest, index) => questNodeFor(quest, index + 1, false, false));

  return {
    sagas,
    campaigns,
    currentSagaId: campaign?.sagaId ?? currentQuest?.sagaId ?? null,
    currentCampaignId: campaign?.id ?? null,
    currentActId: act?.id ?? null,
    currentQuestId: currentQuest?.id ?? null,
    standaloneQuests,
  };
}
