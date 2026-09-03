import { randomUUID } from "node:crypto";
import type {
  AfterActionReport,
  BattleLesson,
  BattleMemoryView,
  CompanionId,
  DurationMemory,
  Quest,
  QuestPlaybook,
  RealmState,
} from "./domain.js";
import { HERO_DISPLAY_NAME } from "./progression.js";

/**
 * TORREÓN DEBE APRENDER.
 *
 * «Pensé que demoraba X, aparecieron checks, tomó mucho más, y la próxima Quest
 * volvió a estimarse mal.» Eso se acaba aquí: cada Battle ganada deja un
 * informe determinista y un rastro de cuánto dura DE VERDAD un trabajo así.
 *
 * Lo aprendido sólo se usa al PLANEAR una Quest nueva. NUNCA muta en silencio
 * un contrato ya aceptado: cambiar el pacto sigue exigiendo el sello del jugador.
 */

const now = () => new Date().toISOString();
const REPORT_LIMIT = 100;
const LESSON_LIMIT = 200;
const PLAYBOOK_LIMIT = 60;

/** Ruido que no distingue una actividad de otra: fechas, períodos, artículos. */
const STOPWORDS = new Set([
  "el", "la", "los", "las", "de", "del", "un", "una", "y", "o", "a", "al", "en",
  "para", "por", "con", "the", "of", "to",
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre",
]);

/**
 * Firma normalizada de una actividad.
 *
 * «Pagar arriendo de marzo» y «Pagar arriendo abril» comparten firma, así que
 * el reino puede reconocerlas como la misma batalla recurrente sin confundir
 * dos trabajos distintos que sólo se parecen en el mes.
 */
export function signatureOf(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word))
    .sort()
    .slice(0, 6)
    .join("-");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

/** Sólo cuenta lo que NO fue anulado: un evento erróneo no enseña nada. */
function liveUnexpectedRequirements(state: RealmState, questId: string): number {
  return (state.lifeEvents ?? []).filter(
    (event) => event.questId === questId && event.type === "unexpected_requirement" && event.status !== "invalidated",
  ).length;
}

/**
 * Reloj ACTIVO real de la Battle, sumando todos los intentos y descontando la
 * espera ajena al jugador. Esperar a un tercero no es haber trabajado.
 */
export function activeDurationMs(quest: Quest): { activeMs: number; externalWaitMs: number } {
  const record = quest.battle;
  if (!record) return { activeMs: 0, externalWaitMs: 0 };
  const externalWaitMs = record.suspendedMs ?? 0;
  const total = record.attempts.reduce((sum, attempt) => {
    const started = Date.parse(attempt.startedAt);
    const ended = attempt.endedAt ? Date.parse(attempt.endedAt) : Date.parse(record.endedAt ?? now());
    return sum + Math.max(0, ended - started);
  }, 0);
  return { activeMs: Math.max(0, total - externalWaitMs), externalWaitMs };
}

/**
 * LECCIONES CONCRETAS Y REUTILIZABLES.
 *
 * Deterministas, derivadas de los hechos de la Battle. Nada de chat guardado y
 * nada que un modelo tenga que inventar.
 */
function lessonsFor(report: Omit<AfterActionReport, "lessons">): string[] {
  const lessons: string[] = [];
  const actualMinutes = Math.round(report.actualActiveMs / 60_000);
  if (report.plannedDurationMinutes > 0 && actualMinutes > Math.round(report.plannedDurationMinutes * 1.25)) {
    lessons.push(
      `«${report.questTitle}» se pactó en ${report.plannedDurationMinutes} min y tomó ${actualMinutes} min de trabajo activo: planifica al menos ${actualMinutes} la próxima vez.`,
    );
  }
  if (report.replans > 0) {
    lessons.push(`Este trabajo necesitó ${report.replans} replanificación(es): el plazo inicial no bastó.`);
  }
  if (report.unexpectedRequirements > 0) {
    lessons.push(`Aparecieron ${report.unexpectedRequirements} exigencia(s) imprevista(s) que no estaban en el contrato original.`);
  }
  if (report.externalWaitMs > 60_000) {
    lessons.push(`Hubo ${Math.round(report.externalWaitMs / 60_000)} min de espera de terceros: no cuentan como trabajo activo al estimar.`);
  }
  for (const tool of report.toolsUsed.slice(0, 3)) {
    lessons.push(`La herramienta «${tool}» resultó útil en esta batalla.`);
  }
  for (const companion of report.companionsUsed) {
    lessons.push(`${HERO_DISPLAY_NAME[companion]} asistió con éxito una batalla de este tipo.`);
  }
  return lessons.slice(0, 6);
}

/**
 * INFORME DE ACCIÓN determinista de una Battle ganada.
 *
 * No requiere LLM: se arma desde el registro de la Battle, las asistencias y
 * los hechos ya validados. La narrativa, si llega, va encima.
 */
export function buildAfterActionReport(state: RealmState, quest: Quest): AfterActionReport {
  const record = quest.battle;
  const { activeMs, externalWaitMs } = activeDurationMs(quest);
  const assists = (state.companionAssists ?? []).filter((assist) => assist.questId === quest.id);
  const executions = (state.companionExecutions ?? []).filter((execution) => execution.questId === quest.id);
  const validated = assists.filter((assist) => assist.status === "contribution_validated");
  const companionsUsed = Array.from(new Set(validated.map((assist) => assist.companion))) as CompanionId[];
  const toolsUsed = Array.from(
    new Set([...assists.map((assist) => assist.sourceTool), ...executions.map((execution) => execution.tool)].filter((tool): tool is string => Boolean(tool))),
  ).slice(0, 8);

  const party = record ? [record.party.roko.name, record.party.marques.name, record.party.cordera.name] : [];
  if (record?.agent.deployed && record.agent.companion) party.push(HERO_DISPLAY_NAME[record.agent.companion]);

  const base = {
    id: randomUUID(),
    questId: quest.id,
    questTitle: quest.title,
    attempts: record?.attempts.length ?? 1,
    plannedDurationMinutes: record?.attempts[0]?.durationMinutes ?? quest.durationMinutes,
    actualActiveMs: activeMs,
    externalWaitMs,
    replans: Math.max(0, (record?.attempts.length ?? 1) - 1),
    unexpectedRequirements: liveUnexpectedRequirements(state, quest.id),
    toolsUsed,
    companionsUsed,
    party,
    agentContribution: {
      executions: executions.length,
      assistedSteps: new Set(validated.map((assist) => assist.stepId)).size,
      comboDamage: record?.agent.comboDamage ?? 0,
    },
    hordeNeutralized: Boolean(record && record.enemies.every((enemy) => enemy.status === "ko")),
    result: "victory" as const,
    outcome: quest.outcome,
    createdAt: now(),
  };

  return { ...base, lessons: lessonsFor(base) };
}

/**
 * Guarda el informe y sus lecciones UNA sola vez por Quest.
 * Devuelve el informe (nuevo o el que ya existía) para no duplicar historia.
 */
export function storeAfterActionReport(state: RealmState, report: AfterActionReport): AfterActionReport {
  state.afterActionReports ??= [];
  const existing = state.afterActionReports.find((candidate) => candidate.questId === report.questId);
  if (existing) return existing;
  state.afterActionReports.unshift(report);
  state.afterActionReports = state.afterActionReports.slice(0, REPORT_LIMIT);

  state.battleLessons ??= [];
  const signature = signatureOf(report.questTitle);
  for (const text of report.lessons) {
    if (state.battleLessons.some((lesson) => lesson.signature === signature && lesson.text === text)) continue;
    const lesson: BattleLesson = { id: randomUUID(), questId: report.questId, signature, text, createdAt: now() };
    state.battleLessons.unshift(lesson);
  }
  state.battleLessons = state.battleLessons.slice(0, LESSON_LIMIT);
  return report;
}

/**
 * PLAYBOOK.
 *
 * Reconocer una batalla repetida no la acepta ni la inicia: sólo deja escrito
 * qué pasos, qué pruebas y qué compañeros funcionaron la última vez. La
 * evidencia del período nuevo SIEMPRE es nueva.
 */
export function upsertPlaybook(state: RealmState, quest: Quest, report: AfterActionReport): QuestPlaybook {
  state.playbooks ??= [];
  const signature = signatureOf(quest.title);
  const typicalDurationMinutes = Math.max(1, Math.round(report.actualActiveMs / 60_000) || quest.durationMinutes);
  const steps = quest.steps
    .filter((step) => step.status !== "superseded")
    .map((step) => ({
      title: step.title,
      description: step.description,
      actor: step.actor,
      evidence: step.evidence,
      evidenceKind: step.evidenceKind,
      verificationHint: step.verificationHint,
      weight: step.weight,
    }));
  const evidenceExpectations = Array.from(new Set(steps.map((step) => step.evidence)));

  const existing = state.playbooks.find((playbook) => playbook.signature === signature);
  if (existing) {
    existing.title = quest.title;
    existing.steps = steps;
    existing.typicalDurationMinutes = Math.round((existing.typicalDurationMinutes * existing.timesUsed + typicalDurationMinutes) / (existing.timesUsed + 1));
    existing.evidenceExpectations = evidenceExpectations;
    existing.preferredCompanions = Array.from(new Set([...existing.preferredCompanions, ...report.companionsUsed]));
    existing.knownFriction = Array.from(new Set([...existing.knownFriction, ...report.lessons])).slice(0, 8);
    existing.timesUsed += 1;
    existing.updatedAt = now();
    return existing;
  }

  const playbook: QuestPlaybook = {
    id: randomUUID(),
    signature,
    title: quest.title,
    steps,
    typicalDurationMinutes,
    evidenceExpectations,
    preferredCompanions: report.companionsUsed,
    knownFriction: report.lessons.slice(0, 8),
    timesUsed: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  state.playbooks.unshift(playbook);
  state.playbooks = state.playbooks.slice(0, PLAYBOOK_LIMIT);
  return playbook;
}

/** Cuánto dura de verdad cada tipo de trabajo, agrupado por firma. */
export function durationMemoryFor(state: RealmState): DurationMemory[] {
  const groups = new Map<string, { title: string; planned: number[]; actual: number[] }>();
  for (const report of state.afterActionReports ?? []) {
    const signature = signatureOf(report.questTitle);
    const group = groups.get(signature) ?? { title: report.questTitle, planned: [], actual: [] };
    group.planned.push(report.plannedDurationMinutes);
    group.actual.push(Math.max(1, Math.round(report.actualActiveMs / 60_000)));
    groups.set(signature, group);
  }
  return Array.from(groups.entries()).map(([signature, group]) => {
    const plannedMedianMinutes = median(group.planned);
    const actualMedianMinutes = median(group.actual);
    return {
      signature,
      title: group.title,
      samples: group.actual.length,
      plannedMedianMinutes,
      actualMedianMinutes,
      driftRatio: plannedMedianMinutes > 0 ? Math.round((actualMedianMinutes / plannedMedianMinutes) * 100) / 100 : 1,
    };
  });
}

export function battleMemoryFor(state: RealmState): BattleMemoryView {
  return {
    durations: durationMemoryFor(state),
    lessons: (state.battleLessons ?? []).slice(0, 30),
    playbooks: state.playbooks ?? [],
    reports: (state.afterActionReports ?? []).slice(0, 10),
  };
}

export interface PlanningHint {
  signature: string;
  /** Duración sugerida por el historial. Sugerencia: no repacta nada sola. */
  suggestedDurationMinutes: number | null;
  historicalMedianMinutes: number | null;
  plannedMedianMinutes: number | null;
  samples: number;
  lessons: string[];
  playbook: QuestPlaybook | null;
  preferredCompanions: CompanionId[];
}

/**
 * Lo que el reino ya sabe sobre un objetivo parecido.
 *
 * Se consulta al PLANEAR. Devolverlo no cambia ningún contrato vivo: si Códice
 * quiere otro plazo, tiene que proponerlo y que el jugador lo selle.
 */
export function planningHintFor(state: RealmState, intent: string): PlanningHint {
  const signature = signatureOf(intent);
  const words = new Set(signature.split("-").filter(Boolean));
  const scored = durationMemoryFor(state)
    .map((memory) => {
      const memoryWords = memory.signature.split("-").filter(Boolean);
      const overlap = memoryWords.filter((word) => words.has(word)).length;
      return { memory, overlap };
    })
    .filter((entry) => entry.overlap >= Math.min(2, words.size))
    .sort((a, b) => b.overlap - a.overlap);

  const best = scored[0]?.memory ?? null;
  const playbook = (state.playbooks ?? []).find((candidate) => candidate.signature === best?.signature) ?? null;
  const lessons = (state.battleLessons ?? [])
    .filter((lesson) => (best ? lesson.signature === best.signature : false))
    .map((lesson) => lesson.text)
    .slice(0, 5);

  return {
    signature,
    suggestedDurationMinutes: best?.actualMedianMinutes ?? null,
    historicalMedianMinutes: best?.actualMedianMinutes ?? null,
    plannedMedianMinutes: best?.plannedMedianMinutes ?? null,
    samples: best?.samples ?? 0,
    lessons,
    playbook,
    preferredCompanions: playbook?.preferredCompanions ?? [],
  };
}
