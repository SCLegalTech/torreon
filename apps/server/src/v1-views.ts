import type {
  BarracksView,
  BattleState,
  CharacterStats,
  CurrentStepSummary,
  InventoryState,
  NotificationView,
  ObligationView,
  OpenFrontView,
  QuestProgress,
  RealmConsistency,
  RealmHierarchy,
  RealmState,
  RecoveryOffer,
  TreasuryView,
  WorldSystemView,
} from "./domain.js";
import { obligationViewFor, treasuryViewFor } from "./finance.js";
import { barracksViewFor } from "./barracks.js";
import { notificationViewsFor, unreadCount } from "./notifications.js";
import {
  consistencyFor,
  currentStepFor,
  hierarchyFor,
  openFrontsFor,
  progressFor,
  recoveryOfferFor,
  statsFor,
  worldSystemsFor,
} from "./read-models.js";

/**
 * LAS VISTAS DE `/v1` — una por pantalla (artículos 12 y 16).
 *
 * `GET /api/state` devolvía `RealmState` entero: el documento persistido, más
 * veinte proyecciones encima. Medido: 143 834 bytes sondeados cada 1,5 s, unos
 * 345 MB por hora y cliente conectado. Y de regalo se filtraba lo que ninguna
 * pantalla necesita: razonamientos del juez, rutas de artefactos en disco,
 * contadores de plan, transacciones financieras completas.
 *
 * Aquí no hay estado nuevo: todo se deriva de la misma verdad en la lectura.
 * Lo único que cambia es que cada pantalla pide LO SUYO.
 */

/** El bastión: quién soy, qué tengo, qué frentes hay abiertos y qué me reclama. */
export interface RealmSummaryView {
  stats: CharacterStats;
  inventory: InventoryState;
  treasury: TreasuryView;
  worldSystems: WorldSystemView[];
  openFronts: OpenFrontView[];
  unreadNotifications: number;
  consistency: RealmConsistency;
  /** El frente que el jugador vería al entrar: comprometido, o el que enfocó. */
  battleQuestId: string | null;
  projectedMargin: number;
}

export function realmSummaryView(
  state: RealmState,
  nowMs: number,
  context: { instance: string; currentQuest: { id: string } | null; engagedQuest: { id: string } | null; battleQuestId: string | null; battle: BattleState | null },
): RealmSummaryView {
  const hierarchy = hierarchyFor(state, null, context.engagedQuest?.id ?? null);
  const openFronts = openFrontsFor(state);
  const unread = unreadCount(state);
  const { availableBalance, expectedIncome, committedExpenses, reserveTarget } = state.financial;
  return {
    stats: statsFor(state, context.battle),
    inventory: state.inventory,
    treasury: treasuryViewFor(state, nowMs),
    worldSystems: worldSystemsFor(state, {
      engagedQuest: null,
      quickBattles: hierarchy.standaloneQuests.length,
      openFronts: openFronts.length,
      activeCampaigns: hierarchy.activeCampaignIds.length,
      unreadNotifications: unread,
    }),
    openFronts,
    unreadNotifications: unread,
    consistency: consistencyFor(state, context.instance, null),
    battleQuestId: context.battleQuestId,
    projectedMargin: availableBalance + expectedIncome - committedExpenses - reserveTarget,
  };
}

/** El frente: lo que Unity anima. Nada de aquí lo decide el renderer. */
export interface BattleView {
  questId: string;
  title: string;
  outcome: string;
  battle: BattleState | null;
  progress: QuestProgress | null;
  currentStep: CurrentStepSummary | null;
  recovery: RecoveryOffer;
}

export function battleView(state: RealmState, questId: string, battle: BattleState | null, nowMs: number): BattleView | null {
  const quest = state.quests.find((candidate) => candidate.id === questId);
  if (!quest) return null;
  void nowMs;
  return {
    questId: quest.id,
    title: quest.title,
    outcome: quest.outcome,
    battle,
    progress: progressFor(quest),
    currentStep: currentStepFor(quest),
    recovery: recoveryOfferFor(state, quest.id),
  };
}

/** El mapa: saga, campañas, actos y quests. Sin nada del expediente. */
export function realmMapView(state: RealmState, engagedQuestId: string | null): RealmHierarchy {
  return hierarchyFor(state, null, engagedQuestId);
}

export function barracksView(state: RealmState): BarracksView {
  return barracksViewFor(state);
}

export function notificationsView(state: RealmState, nowMs: number, query: Parameters<typeof notificationViewsFor>[2] = {}): {
  notifications: NotificationView[];
  unread: number;
} {
  return { notifications: notificationViewsFor(state, nowMs, query), unread: unreadCount(state) };
}

export function treasuryView(state: RealmState, nowMs: number): { obligations: ObligationView[]; treasury: TreasuryView } {
  return {
    obligations: state.recurringObligations.map((obligation) => obligationViewFor(obligation, nowMs)),
    treasury: treasuryViewFor(state, nowMs),
  };
}

/**
 * EL CURSOR.
 *
 * Ata una foto a un punto exacto del expediente. El cliente pide la vista,
 * recibe el cursor de esa foto, y se suscribe DESDE AHÍ: sin él queda una
 * ventana en la que un hecho se pierde entre la foto y la suscripción.
 *
 * Es opaco a propósito. Hoy es el id del último hecho del reino; cuando el
 * reino viva en SQLite podrá ser su `seq` sin que ningún cliente se entere.
 */
export function cursorOf(state: RealmState): string {
  return state.events[0]?.id ?? "";
}
