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
  OpenFrontView,
  Quest,
  QuestDetail,
  QuestNode,
  QuestProgress,
  RealmConsistency,
  RealmHierarchy,
  RealmState,
  RecoveryOffer,
  SagaView,
  WorldSystemView,
} from "./domain.js";
import { battleStatusOf } from "./battle.js";
import { PARTY_MAX_HEALTH, PARTY_ORDER, recoveryHealth } from "./party.js";

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

  // Varias campañas y varias quests listas son legítimas; lo que no puede
  // duplicarse es el frente comprometido, el único con reloj corriendo.
  const engagedQuests = state.quests.filter((quest) => quest.status === "active" && quest.battle?.status === "active");
  if (engagedQuests.length > 1) {
    issues.push({
      code: "MULTIPLE_ACTIVE_QUESTS",
      entityId: engagedQuests[0].id,
      message: `Hay ${engagedQuests.length} Battles con reloj corriendo y sólo puede haber una.`,
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
    activeQuestCount: engagedQuests.length,
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

/**
 * POSITION IS PRESENTATION, NOT PERMISSION.
 *
 * Una Quest sólo espera turno si DECLARA una dependencia y esa dependencia
 * sigue abierta, o si su Acto está bloqueado por una dependencia explícita.
 * Estar tercera en una lista, no ser la `currentQuestId` legada o no haber
 * llegado la última notificación NO bloquean absolutamente nada.
 */
export function questLockFor(state: RealmState, quest: Quest, actLocked: boolean, actTitle?: string): { locked: boolean; lockedBy?: string } {
  if (actLocked) return { locked: true, lockedBy: actTitle ? `El acto «${actTitle}» todavía no está disponible.` : "Su acto todavía no está disponible." };
  const deps = quest.dependsOnQuestIds ?? [];
  for (const depId of deps) {
    const dependency = state.quests.find((candidate) => candidate.id === depId);
    if (!dependency) continue;
    if (!CLOSED_QUEST.has(dependency.status)) {
      return { locked: true, lockedBy: `Depende de «${dependency.title}», que sigue abierta.` };
    }
  }
  return { locked: false };
}

function questNodeFor(
  quest: Quest,
  position: number,
  lock: { locked: boolean; lockedBy?: string },
  isBoss: boolean,
  financeKind?: QuestNode["financeKind"],
): QuestNode {
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
    battleStatus: battleStatusOf(quest),
    locked: lock.locked,
    lockedBy: lock.lockedBy,
    isBoss,
    scope: !quest.actId && !quest.campaignId ? "standalone" : "campaign",
    financeKind,
  };
}

function actViewFor(state: RealmState, act: Act, position: number, locked: boolean): ActView {
  const quests = act.questIds
    .map((questId) => state.quests.find((quest) => quest.id === questId))
    .filter((quest): quest is Quest => Boolean(quest));

  // GHOST LOCK ELIMINADO: ya no se bloquea por posición. Sólo una dependencia
  // declarada —de la Quest o de su Acto— puede hacer que una Quest espere turno.
  const nodes = quests.map((quest, index) =>
    questNodeFor(quest, index + 1, questLockFor(state, quest, locked, act.title), index === quests.length - 1 && quests.length > 1),
  );

  const completedQuests = quests.filter((quest) => quest.status === "completed").length;
  return {
    id: act.id,
    position,
    title: act.title,
    subtitle: act.subtitle,
    outcome: act.outcome,
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

/**
 * ACTOS EN PARALELO POR DEFECTO.
 *
 * Un Acto ya no se bloquea por su POSICIÓN: sólo si declara `dependsOnActIds` y
 * alguno de esos Actos todavía no está cerrado. Sin dependencia, disponible.
 */
function actIsLocked(state: RealmState, act: Act): boolean {
  const deps = act.dependsOnActIds ?? [];
  if (deps.length === 0) return false;
  return deps.some((depId) => {
    const dependency = state.acts.find((candidate) => candidate.id === depId);
    return !dependency || !["completed", "abandoned"].includes(dependency.status);
  });
}

function campaignViewFor(state: RealmState, campaign: Campaign): CampaignView {
  const acts = campaign.actIds
    .map((actId) => state.acts.find((act) => act.id === actId))
    .filter((act): act is Act => Boolean(act))
    .map((act, index) => actViewFor(state, act, index + 1, actIsLocked(state, act)));

  // Una quest puede colgar de la campaña sin Acto intermedio: también cuenta.
  const direct = state.quests.filter((quest) => quest.campaignId === campaign.id && !quest.actId);
  const directQuests = direct.map((quest, index) => questNodeFor(quest, index + 1, questLockFor(state, quest, false), false));

  const completedActs = acts.filter((act) => act.status === "completed").length;
  const totalQuests = acts.reduce((sum, act) => sum + act.totalQuests, 0) + directQuests.length;
  const completedQuests =
    acts.reduce((sum, act) => sum + act.completedQuests, 0) + direct.filter((quest) => quest.status === "completed").length;
  return {
    id: campaign.id,
    title: campaign.title,
    summary: campaign.summary,
    objective: campaign.objective,
    intent: campaign.intent,
    rationale: campaign.rationale,
    status: campaign.status,
    estimatedCalendarDays: campaign.estimatedCalendarDays,
    estimatedActiveMinutes: campaign.estimatedActiveMinutes,
    scenario: campaign.scenario,
    bossTitle: campaign.bossTitle,
    bossDescription: campaign.bossDescription,
    acts,
    directQuests,
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

export function hierarchyFor(state: RealmState, currentQuest: Quest | null, engagedQuestId: string | null = null): RealmHierarchy {
  const campaigns = state.campaigns.map((campaign) => campaignViewFor(state, campaign));
  const sagas = state.sagas.map(sagaViewFor(state, campaigns));

  const act = currentQuest?.actId ? state.acts.find((candidate) => candidate.id === currentQuest.actId) ?? null : null;
  const campaign = act?.campaignId
    ? state.campaigns.find((candidate) => candidate.id === act.campaignId) ?? null
    : currentQuest?.campaignId
      ? state.campaigns.find((candidate) => candidate.id === currentQuest.campaignId) ?? null
      : null;

  // QUICK BATTLES / BATALLAS LIBRES: sin Acto ni Campaña, y eso es legítimo.
  // No se les fabrica padre. Se marca su representación financiera si la tienen.
  const financeByQuestId = new Map(
    (state.financialTransactions ?? []).filter((tx) => tx.questId).map((tx) => [tx.questId!, tx.direction]),
  );
  const financeQuestNames = new Set(
    (state.recurringObligations ?? []).flatMap((obligation) => [obligation.name.toLowerCase()]),
  );
  const standaloneQuests = state.quests
    .filter((quest) => !quest.actId && !quest.campaignId && !CLOSED_QUEST.has(quest.status))
    .map((quest, index) =>
      questNodeFor(
        quest,
        index + 1,
        questLockFor(state, quest, false),
        false,
        financeByQuestId.get(quest.id) ??
          (financeQuestNames.has(quest.title.toLowerCase()) ? "expense" : undefined),
      ),
    );

  return {
    sagas,
    // MANY CAMPAIGNS: todas siguen vivas aunque el jugador mire sólo una.
    activeCampaignIds: state.campaigns.filter((candidate) => candidate.status === "active").map((candidate) => candidate.id),
    focusedCampaignId: state.focusedCampaignId ?? campaign?.id ?? null,
    focusedQuestId: state.focusedQuestId ?? null,
    focusedActId: state.focusedActId ?? null,
    engagedQuestId,
    campaigns,
    currentSagaId: campaign?.sagaId ?? currentQuest?.sagaId ?? null,
    currentCampaignId: campaign?.id ?? null,
    currentActId: act?.id ?? null,
    currentQuestId: currentQuest?.id ?? null,
    standaloneQuests,
  };
}

// ---------------------------------------------------------------------------
// SISTEMAS DEL MUNDO
//
// TREASURY IS NOT A QUICK BATTLE.
//
// La jerarquía de navegación la fija el Core, no la maqueta: Barracas y
// Tesorería son HERMANAS de Batallas Libres y de Campañas, nunca hijas suyas.
// Un renderer que quiera moverlas tendrá que discutirlo con este modelo.
// ---------------------------------------------------------------------------

export function worldSystemsFor(
  state: RealmState,
  input: {
    engagedQuest: Quest | null;
    quickBattles: number;
    openFronts: number;
    activeCampaigns: number;
    unreadNotifications: number;
  },
): WorldSystemView[] {
  const systems: WorldSystemView[] = [];
  if (input.engagedQuest) {
    systems.push({
      id: "battle",
      icon: "⚔️",
      label: "BATALLA ACTIVA",
      detail: input.engagedQuest.title,
      screen: "battle",
      entityId: input.engagedQuest.id,
    });
  }
  // BATALLAS LIBRES ES UNA RUTA REAL, NO UN ANCLA.
  //
  // Antes esto declaraba `screen: "realm"`, es decir «ya estás donde tienes que
  // estar»: el botón del menú quedaba muerto porque no llevaba a ninguna parte.
  // Ahora nombra su propia pantalla, y esa pantalla abre SIEMPRE —con Battles o
  // con un estado vacío explícito.
  systems.push({
    id: "quick_battles",
    icon: "⚡",
    label: "BATALLAS LIBRES",
    detail:
      input.openFronts > 0
        ? `${input.openFronts} frente(s) · ${input.quickBattles} libre(s)`
        : input.quickBattles === 0
          ? "Sin Battles abiertas"
          : `${input.quickBattles} abierta(s)`,
    screen: "quick_battles",
    badge: input.quickBattles + input.openFronts || undefined,
  });
  systems.push({
    id: "campaigns",
    icon: "🏰",
    label: "CAMPAÑAS",
    detail: input.activeCampaigns === 0 ? "Ningún frente abierto" : `${input.activeCampaigns} frente(s) abierto(s)`,
    screen: "campaign",
    badge: input.activeCampaigns || undefined,
  });
  systems.push({
    id: "barracks",
    icon: "🛡️",
    label: "BARRACAS",
    detail: "El grupo y los agentes con su historia real",
    screen: "barracks",
  });
  systems.push({
    id: "treasury",
    icon: "💰",
    label: "TESORERÍA",
    detail: "Dinero real del reino",
    screen: "treasury",
  });
  systems.push({
    id: "notifications",
    icon: "🔔",
    label: "NOTIFICACIONES",
    detail: input.unreadNotifications > 0 ? `${input.unreadNotifications} sin leer` : "Sin avisos pendientes",
    screen: "notifications",
    badge: input.unreadNotifications || undefined,
  });
  return systems;
}

// ---------------------------------------------------------------------------
// FRENTES ABIERTOS
//
// UNA BATTLE NO PUEDE VIVIR SÓLO DENTRO DE SU NOTIFICACIÓN.
//
// La Battle de una Quest de Campaña estaba a tres pantallas y un cambio de foco
// de distancia; si el aviso se archivaba, dejaba de existir para el jugador.
// Esta proyección la devuelve al menú por su id exacto, sin heurísticas de
// «la última» ni dependencias de `currentQuestId`.
// ---------------------------------------------------------------------------

export function openFrontsFor(state: RealmState): OpenFrontView[] {
  return state.quests
    .filter((quest) => quest.battle && quest.battle.status !== "won")
    .map((quest) => {
      const record = quest.battle!;
      const act = quest.actId ? state.acts.find((candidate) => candidate.id === quest.actId) ?? null : null;
      const campaignId = act?.campaignId ?? quest.campaignId;
      const campaign = campaignId ? state.campaigns.find((candidate) => candidate.id === campaignId) ?? null : null;
      return {
        questId: quest.id,
        title: quest.title,
        campaignTitle: campaign?.title ?? null,
        actTitle: act?.title ?? null,
        status: quest.status,
        battleStatus: record.status,
        percent: Math.min(100, quest.steps.reduce((sum, step) => sum + step.impactAwarded, 0)),
        durationMinutes: record.durationMinutes,
        attempt: record.attempt,
        engaged: record.status === "active",
        marquisDown: record.party.marques.health === 0,
      };
    })
    // El frente con reloj primero: es el único que está corriendo el tiempo.
    .sort((a, b) => Number(b.engaged) - Number(a.engaged));
}

/**
 * ¿Hay una retirada táctica sobre la mesa?
 *
 * Sólo cuando el frente ya no corre —plazo vencido o Marqués caído— y no hay
 * ninguna otra Battle comprometida. Con el reloj corriendo NO se ofrece: eso
 * sería resucitar dentro del intento, y eso no existe.
 */
export function recoveryOfferFor(state: RealmState, questId: string | null): RecoveryOffer {
  const minHealth = recoveryHealth(PARTY_MAX_HEALTH);
  const quest = questId ? state.quests.find((candidate) => candidate.id === questId) ?? null : null;
  if (!quest?.battle) {
    return { questId: null, available: false, minHealth, reason: "No hay ningún frente abierto del que retirarse." };
  }
  const record = quest.battle;
  if (record.status === "active") {
    return {
      questId: quest.id,
      available: false,
      minHealth,
      reason: "El reloj sigue corriendo: la retirada es para un frente detenido, no para saltarse el tiempo pactado.",
    };
  }
  if (record.status === "won") {
    return { questId: quest.id, available: false, minHealth, reason: "Esta Battle ya está ganada." };
  }
  if (record.status === "suspended_external") {
    return {
      questId: quest.id,
      available: false,
      minHealth,
      reason: "Este frente espera a un tercero real: se reanuda al desbloquearse.",
    };
  }
  if (state.quests.some((candidate) => candidate.id !== quest.id && candidate.battle?.status === "active")) {
    return {
      questId: quest.id,
      available: false,
      minHealth,
      reason: "Hay otra Battle con el reloj corriendo. Ciérrala antes de retirar al grupo.",
    };
  }
  if (PARTY_ORDER.every((id) => record.party[id].health > 0)) {
    return { questId: quest.id, available: false, minHealth, reason: "Nadie está en el suelo: no hay a quién levantar." };
  }
  return { questId: quest.id, available: true, minHealth, reason: null };
}
