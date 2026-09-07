import { randomUUID } from "node:crypto";
import type {
  FinancialState,
  FinancialTransaction,
  ObligationDirection,
  ObligationDueRule,
  ObligationFrequency,
  ObligationView,
  RealmState,
  RecurringObligation,
  TreasuryView,
} from "./domain.js";

/**
 * TESORERÍA VIVA.
 *
 * Torreón empieza a representar gastos e ingresos recurrentes reales. NO es
 * Open Banking ni contabilidad completa: dos modelos mínimos y una conciliación
 * por período. El dinero real vive en COP y jamás se confunde con un recurso
 * comprable del juego.
 *
 * REWARD ≠ CASH: pagar una obligación concede XP/Aura, pero el dinero SALE de la
 * Tesorería. Nunca se otorgan monedas ficticias por gastar dinero real.
 */

/** "YYYY-MM" del período de una fecha. La unidad de conciliación es el mes. */
export function periodOf(dateIso: string | number | Date): string {
  return new Date(dateIso).toISOString().slice(0, 7);
}

/** Meses que abarca cada frecuencia, para avanzar el vencimiento. */
const FREQUENCY_MONTHS: Record<ObligationFrequency, number> = {
  weekly: 0,
  biweekly: 0,
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  yearly: 12,
};

const FREQUENCY_DAYS: Partial<Record<ObligationFrequency, number>> = {
  weekly: 7,
  biweekly: 14,
};
import { isoAt } from "./clock.js";

/**
 * Próximo vencimiento a partir de `from`. Sin regla comprobable devuelve null:
 * no se inventa una fecha que la realidad todavía no dio.
 */
export function nextDueDateFor(
  frequency: ObligationFrequency,
  dueRule: ObligationDueRule,
  from: Date,
): string | null {
  if (dueRule.type === "date" && dueRule.date) {
    const target = new Date(dueRule.date);
    return Number.isNaN(target.getTime()) ? null : target.toISOString();
  }

  if (dueRule.type === "day_of_month" && typeof dueRule.day === "number") {
    const day = Math.min(28, Math.max(1, Math.round(dueRule.day)));
    const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, 12, 0, 0));
    if (candidate.getTime() < from.getTime()) {
      const months = FREQUENCY_MONTHS[frequency] || 1;
      candidate.setUTCMonth(candidate.getUTCMonth() + months);
    }
    return candidate.toISOString();
  }

  if (dueRule.type === "day_of_week" && typeof dueRule.day === "number") {
    const target = ((Math.round(dueRule.day) % 7) + 7) % 7;
    const candidate = new Date(from.getTime());
    candidate.setUTCHours(12, 0, 0, 0);
    const delta = (target - candidate.getUTCDay() + 7) % 7 || 7;
    candidate.setUTCDate(candidate.getUTCDate() + delta);
    return candidate.toISOString();
  }

  return null;
}

/** Avanza el vencimiento un ciclo de la frecuencia desde `from`. */
export function advanceDueDate(obligation: RecurringObligation, from: Date): string | null {
  const days = FREQUENCY_DAYS[obligation.frequency];
  if (days) {
    const candidate = new Date(from.getTime());
    candidate.setUTCDate(candidate.getUTCDate() + days);
    return candidate.toISOString();
  }
  return nextDueDateFor(obligation.frequency, obligation.dueRule, from);
}

export interface RecurringObligationInput {
  name: string;
  direction: ObligationDirection;
  category?: string;
  frequency: ObligationFrequency;
  expectedAmount?: number | null;
  provider?: string;
  dueRule?: ObligationDueRule;
  active?: boolean;
  autoProposeBattle?: boolean;
}

export function buildRecurringObligation(input: RecurringObligationInput, nowMs: number): RecurringObligation {
  const timestamp = isoAt(nowMs);
  const dueRule: ObligationDueRule = input.dueRule ?? { type: "unknown" };
  const expectedAmount =
    input.expectedAmount === undefined || input.expectedAmount === null
      ? null
      : Math.max(0, Math.round(input.expectedAmount));
  return {
    id: randomUUID(),
    name: input.name.trim().slice(0, 120),
    direction: input.direction,
    category: (input.category ?? (input.direction === "income" ? "income" : "other")).trim().slice(0, 60),
    frequency: input.frequency,
    expectedAmount,
    currency: "COP",
    provider: input.provider?.trim().slice(0, 120) || undefined,
    dueRule,
    nextDueDate: nextDueDateFor(input.frequency, dueRule, new Date(nowMs)),
    lastPaidPeriod: null,
    active: input.active ?? true,
    autoProposeBattle: input.autoProposeBattle ?? true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export interface FinancialTransactionInput {
  direction: ObligationDirection;
  /** Monto real, obligatorio. NUNCA se infiere del impacto de una Quest. */
  amount: number;
  occurredAt?: string;
  recurringObligationId?: string;
  questId?: string;
  evidenceArtifactId?: string;
  note?: string;
  status?: FinancialTransaction["status"];
}

export function buildFinancialTransaction(input: FinancialTransactionInput, nowMs: number): FinancialTransaction {
  const occurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : isoAt(nowMs);
  return {
    id: randomUUID(),
    direction: input.direction,
    amount: Math.max(0, Math.round(input.amount)),
    currency: "COP",
    occurredAt,
    period: periodOf(occurredAt),
    recurringObligationId: input.recurringObligationId,
    questId: input.questId,
    evidenceArtifactId: input.evidenceArtifactId,
    note: input.note?.trim().slice(0, 500) || undefined,
    status: input.status ?? "confirmed",
    createdAt: isoAt(nowMs),
  };
}

/**
 * Estado del PERÍODO en curso de una obligación. Nunca «pagado para siempre»:
 * septiembre puede estar PAID y octubre PENDING sobre la misma obligación.
 */
export function obligationPeriodStatus(
  obligation: RecurringObligation,
  nowMs: number,
): "paid" | "pending" | "upcoming" {
  const current = periodOf(nowMs);
  if (obligation.lastPaidPeriod === current) return "paid";
  if (!obligation.nextDueDate) return "pending";
  const due = new Date(obligation.nextDueDate);
  if (Number.isNaN(due.getTime())) return "pending";
  // Vence este mes o ya venció -> pendiente. Vence más adelante -> próximo.
  return periodOf(due) <= current ? "pending" : "upcoming";
}

export function obligationViewFor(obligation: RecurringObligation, nowMs: number): ObligationView {
  return {
    id: obligation.id,
    name: obligation.name,
    direction: obligation.direction,
    category: obligation.category,
    frequency: obligation.frequency,
    expectedAmount: obligation.expectedAmount,
    currency: obligation.currency,
    provider: obligation.provider,
    nextDueDate: obligation.nextDueDate,
    periodStatus: obligation.active ? obligationPeriodStatus(obligation, nowMs) : "upcoming",
    currentPeriod: periodOf(nowMs),
    lastPaidPeriod: obligation.lastPaidPeriod,
    active: obligation.active,
    autoProposeBattle: obligation.autoProposeBattle,
  };
}

export function treasuryViewFor(state: RealmState, nowMs: number): TreasuryView {
  const financial: FinancialState = state.financial;
  const recurring = (state.recurringObligations ?? [])
    .map((obligation) => obligationViewFor(obligation, nowMs))
    .sort((a, b) => (a.nextDueDate ?? "9999").localeCompare(b.nextDueDate ?? "9999"));
  const projectedMargin =
    financial.availableBalance + financial.expectedIncome - financial.committedExpenses - financial.reserveTarget;
  return {
    currency: financial.currency,
    observedBalance: financial.availableBalance,
    expectedIncome: financial.expectedIncome,
    committedExpenses: financial.committedExpenses,
    reserveTarget: financial.reserveTarget,
    projectedMargin,
    upcomingObligations: recurring.filter((obligation) => obligation.active && obligation.periodStatus !== "paid"),
    recurring,
  };
}
