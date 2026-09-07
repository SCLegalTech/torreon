import type {
  FinancialTransaction,
  ObligationView,
  RealmState,
  RecurringObligation,
  TreasuryView,
} from "./domain.js";
import { isoAt } from "./clock.js";
import {
  advanceDueDate,
  buildFinancialTransaction,
  buildRecurringObligation,
  obligationViewFor,
  periodOf,
  treasuryViewFor,
  type FinancialTransactionInput,
  type RecurringObligationInput,
} from "./finance.js";
import { addEvent, markEntityNotificationsRead } from "./realm-events.js";

/**
 * TESORERÍA VIVA.
 *
 * Extraída de `quest-service.ts` (artículo 9: el orquestador sólo puede
 * encoger). El dinero del reino es dinero REAL en COP y sólo lo mueve un hecho
 * financiero comprobado: nunca el `impact` de una Quest, nunca una moneda de
 * juego por gastar dinero de verdad.
 *
 * Funciones puras sobre el estado. No conocen el almacén ni el transporte: el
 * servicio las envuelve en una mutación y ellas deciden.
 */

const TRANSACTION_LIMIT = 500;

export function createObligation(state: RealmState, input: RecurringObligationInput, nowMs: number): RecurringObligation {
  if (input.name.trim().length < 2) throw new Error("La obligación necesita un nombre.");
  const obligation = buildRecurringObligation(input, nowMs);
  state.recurringObligations.unshift(obligation);
  addEvent(
    state,
    {
      type: "recurring_obligation_created",
      entityType: "quest",
      entityId: obligation.id,
      message: `${obligation.direction === "income" ? "Ingreso" : "Gasto"} recurrente registrado: «${obligation.name}».`,
    },
    nowMs,
  );
  return obligation;
}

export type ObligationPatch = Partial<
  Pick<RecurringObligation, "name" | "expectedAmount" | "provider" | "dueRule" | "frequency" | "category" | "active" | "autoProposeBattle">
>;

export function updateObligation(
  state: RealmState,
  obligationId: string,
  patch: ObligationPatch,
  nowMs: number,
): RecurringObligation {
  const obligation = state.recurringObligations.find((candidate) => candidate.id === obligationId);
  if (!obligation) throw new Error(`Obligación no encontrada: ${obligationId}`);
  if (patch.name !== undefined) obligation.name = patch.name.trim().slice(0, 120);
  if (patch.expectedAmount !== undefined) {
    obligation.expectedAmount = patch.expectedAmount === null ? null : Math.max(0, Math.round(patch.expectedAmount));
  }
  if (patch.provider !== undefined) obligation.provider = patch.provider?.trim().slice(0, 120) || undefined;
  if (patch.category !== undefined) obligation.category = patch.category.trim().slice(0, 60);
  if (patch.frequency !== undefined) obligation.frequency = patch.frequency;
  if (patch.active !== undefined) obligation.active = patch.active;
  if (patch.autoProposeBattle !== undefined) obligation.autoProposeBattle = patch.autoProposeBattle;
  if (patch.dueRule !== undefined) obligation.dueRule = patch.dueRule;
  if (patch.dueRule !== undefined || patch.frequency !== undefined) {
    obligation.nextDueDate = advanceDueDate(obligation, new Date(nowMs));
  }
  obligation.updatedAt = isoAt(nowMs);
  addEvent(
    state,
    {
      type: "recurring_obligation_updated",
      entityType: "quest",
      entityId: obligation.id,
      message: `Obligación actualizada: «${obligation.name}».`,
    },
    nowMs,
  );
  return obligation;
}

export function obligationsView(state: RealmState, nowMs: number): { obligations: ObligationView[]; treasury: TreasuryView } {
  return {
    obligations: state.recurringObligations.map((obligation) => obligationViewFor(obligation, nowMs)),
    treasury: treasuryViewFor(state, nowMs),
  };
}

export interface TransactionOutcome {
  transaction: FinancialTransaction;
  obligation: RecurringObligation | null;
  duplicate: boolean;
}

/**
 * Registra un pago o ingreso VALIDADO.
 *
 * El monto es obligatorio y explícito: nunca se deriva del `impact` de una
 * Quest. Idempotente por evidencia: la misma prueba no crea dos movimientos.
 */
export function recordTransaction(state: RealmState, input: FinancialTransactionInput, nowMs: number): TransactionOutcome {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error("El monto real es obligatorio y debe ser mayor que cero. No se infiere del impacto de la Quest.");
  }
  const obligation = input.recurringObligationId
    ? state.recurringObligations.find((candidate) => candidate.id === input.recurringObligationId) ?? null
    : null;
  if (input.recurringObligationId && !obligation) {
    throw new Error(`Obligación no encontrada: ${input.recurringObligationId}`);
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt).toISOString() : isoAt(nowMs);
  const period = periodOf(occurredAt);

  // La misma evidencia —o el mismo pago ya conciliado— no entra dos veces.
  const amount = Math.max(0, Math.round(input.amount));
  const existing = state.financialTransactions.find(
    (candidate) =>
      candidate.period === period &&
      candidate.direction === input.direction &&
      ((input.evidenceArtifactId && candidate.evidenceArtifactId === input.evidenceArtifactId) ||
        (input.questId && candidate.questId === input.questId) ||
        (input.recurringObligationId &&
          candidate.recurringObligationId === input.recurringObligationId &&
          candidate.amount === amount)),
  );
  if (existing) return { transaction: existing, obligation, duplicate: true };

  const transaction = buildFinancialTransaction({ ...input, occurredAt }, nowMs);
  state.financialTransactions.unshift(transaction);
  state.financialTransactions = state.financialTransactions.slice(0, TRANSACTION_LIMIT);

  // PERIOD RECONCILIATION: se marca pagado ESTE período, no «para siempre».
  if (obligation && transaction.status === "confirmed") {
    obligation.lastPaidPeriod = period;
    obligation.nextDueDate = advanceDueDate(obligation, new Date(occurredAt));
    obligation.updatedAt = isoAt(nowMs);
    // El aviso de «período pendiente» de esta obligación deja de pesar.
    markEntityNotificationsRead(state, obligation.id, "recurring_obligation_due", nowMs);
  }

  // El dinero real se mueve en la Tesorería. Ninguna moneda de juego nace aquí.
  if (transaction.status === "confirmed") {
    if (transaction.direction === "expense") {
      state.financial.availableBalance = Math.max(0, state.financial.availableBalance - transaction.amount);
    } else {
      state.financial.availableBalance += transaction.amount;
    }
  }

  addEvent(
    state,
    {
      type: "financial_transaction_recorded",
      entityType: "quest",
      entityId: transaction.questId ?? obligation?.id ?? transaction.id,
      questId: transaction.questId,
      message: `${transaction.direction === "income" ? "Ingreso" : "Pago"} confirmado por ${transaction.amount.toLocaleString("es-CO")} COP${obligation ? ` (${obligation.name}, ${period})` : ""}.`,
    },
    nowMs,
  );
  return { transaction, obligation, duplicate: false };
}
