import { MONEY_SCHEMA_VERSION, assertIntegerCents, domainError, toSafeCents, toSafeSignedCents } from "./money.ts";

export type PaymentStatus = "issued_unpaid" | "partially_paid" | "settled" | "overdue" | "refund_due";
export type SettledBy = "payment" | "credit" | "zero_invoice" | "mixed" | null;
export type LedgerEntryType = "payment" | "refund" | "reversal";

export type LedgerEntry = {
  entry_id: string;
  type: LedgerEntryType;
  amount_cents: number;
  reverses_entry_id: string | null;
};

export type RefundAllocation = {
  refund_entry_id: string;
  payment_entry_id: string;
  amount_cents: number;
};

export type LedgerState = {
  invoice_issued_cents: number;
  credits_cents: number;
  entries: readonly LedgerEntry[];
  allocations: readonly RefundAllocation[];
  voided: boolean;
  due_date: string | null;
  agreed_job_total_cents?: number | null;
};

export type LedgerView = {
  schema_version: typeof MONEY_SCHEMA_VERSION;
  invoice_issued_cents: number;
  agreed_job_total_cents: number | null;
  credits_cents: number;
  effective_payments_cents: number;
  effective_refunds_cents: number;
  net_received_cents: number;
  balance_cents: number;
  amount_due_cents: number;
  amount_to_refund_cents: number;
  payment_status: PaymentStatus;
  settled_by: SettledBy;
  voided: boolean;
};

type EffectiveLedger = {
  reversed: Set<string>;
  effectivePayments: Map<string, bigint>;
  effectiveRefunds: Map<string, bigint>;
  paymentOrder: string[];
};

function requireId(id: string, field: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw domainError("VALIDATION_FAILED", `${field} is required`, field);
  }
  return id;
}

function loadEffective(state: LedgerState): EffectiveLedger {
  const byId = new Map<string, LedgerEntry>();
  const reversed = new Set<string>();
  const paymentOrder: string[] = [];
  for (const entry of state.entries) {
    if (byId.has(entry.entry_id)) {
      throw domainError("VALIDATION_FAILED", "Ledger entry identifiers must be unique", "entry_id");
    }
    byId.set(entry.entry_id, entry);
    if (entry.type === "payment") {
      paymentOrder.push(entry.entry_id);
    }
  }
  for (const entry of state.entries) {
    if (entry.type !== "reversal") {
      continue;
    }
    const originalId = entry.reverses_entry_id;
    if (!originalId) {
      throw domainError("VALIDATION_FAILED", "A reversal must reference exactly one original entry", "reverses_entry_id");
    }
    const original = byId.get(originalId);
    if (!original || original.type === "reversal") {
      throw domainError("VALIDATION_FAILED", "A reversal must reference a payment or refund on this invoice", "reverses_entry_id");
    }
    if (reversed.has(originalId)) {
      throw domainError("ENTRY_ALREADY_REVERSED", "An entry can be reversed only once", "reverses_entry_id");
    }
    reversed.add(originalId);
  }

  const effectivePayments = new Map<string, bigint>();
  const effectiveRefunds = new Map<string, bigint>();
  for (const entry of state.entries) {
    if (entry.type === "payment" && !reversed.has(entry.entry_id)) {
      effectivePayments.set(entry.entry_id, BigInt(entry.amount_cents));
    }
    if (entry.type === "refund" && !reversed.has(entry.entry_id)) {
      effectiveRefunds.set(entry.entry_id, BigInt(entry.amount_cents));
    }
  }

  const allocatedByRefund = new Map<string, bigint>();
  for (const allocation of state.allocations) {
    const refund = byId.get(allocation.refund_entry_id);
    const payment = byId.get(allocation.payment_entry_id);
    if (!refund || refund.type !== "refund") {
      throw domainError("VALIDATION_FAILED", "Refund allocation must reference a refund on this invoice", "refund_entry_id");
    }
    if (!payment || payment.type !== "payment") {
      throw domainError("VALIDATION_FAILED", "Refund allocation must reference a payment on this invoice", "payment_entry_id");
    }
    if (reversed.has(allocation.refund_entry_id)) {
      continue;
    }
    const remainingPayment = effectivePayments.get(allocation.payment_entry_id);
    if (remainingPayment === undefined) {
      throw domainError("VALIDATION_FAILED", "A refund cannot depend on a reversed payment", "payment_entry_id");
    }
    const amount = BigInt(allocation.amount_cents);
    if (amount <= 0n) {
      throw domainError("VALIDATION_FAILED", "Allocation amounts must be positive cents", "amount_cents");
    }
    if (amount > remainingPayment) {
      throw domainError("VALIDATION_FAILED", "Cumulative refund allocation cannot exceed a payment", "amount_cents");
    }
    effectivePayments.set(allocation.payment_entry_id, remainingPayment - amount);
    allocatedByRefund.set(
      allocation.refund_entry_id,
      (allocatedByRefund.get(allocation.refund_entry_id) ?? 0n) + amount,
    );
  }
  for (const [refundId, refundAmount] of effectiveRefunds) {
    const allocated = allocatedByRefund.get(refundId) ?? 0n;
    if (allocated !== refundAmount) {
      throw domainError("VALIDATION_FAILED", "A refund must be fully allocated to payments on this invoice");
    }
  }

  return { reversed, effectivePayments, effectiveRefunds, paymentOrder };
}

function sumMap(values: Map<string, bigint>): bigint {
  let total = 0n;
  for (const value of values.values()) {
    total += value;
  }
  return total;
}

export function deriveLedger(
  state: LedgerState,
  options: { as_of_date?: string | null } = {},
): LedgerView {
  const invoice = assertIntegerCents(state.invoice_issued_cents, "invoice_issued_cents");
  const credits = assertIntegerCents(state.credits_cents, "credits_cents");
  if (invoice < 0n || credits < 0n) {
    throw domainError("VALIDATION_FAILED", "Invoice and credit totals cannot be negative");
  }
  const effective = loadEffective(state);
  const remainingPayments = sumMap(effective.effectivePayments);
  const refunds = sumMap(effective.effectiveRefunds);
  const postedPayments = remainingPayments + refunds;
  const balance = invoice - credits - postedPayments + refunds;
  const amountDue = balance > 0n ? balance : 0n;
  const amountToRefund = balance < 0n ? -balance : 0n;
  const netReceived = postedPayments - refunds;

  let payment_status: PaymentStatus;
  if (balance < 0n) {
    payment_status = "refund_due";
  } else if (balance === 0n) {
    payment_status = "settled";
  } else if (state.due_date && options.as_of_date && state.due_date < options.as_of_date) {
    payment_status = "overdue";
  } else if (postedPayments > 0n) {
    payment_status = "partially_paid";
  } else {
    payment_status = "issued_unpaid";
  }

  let settled_by: SettledBy = null;
  if (payment_status === "settled") {
    if (invoice === 0n && credits === 0n && postedPayments === 0n) {
      settled_by = "zero_invoice";
    } else if (credits > 0n && netReceived === 0n) {
      settled_by = "credit";
    } else if (credits > 0n && netReceived > 0n) {
      settled_by = "mixed";
    } else {
      settled_by = "payment";
    }
  }

  return {
    schema_version: MONEY_SCHEMA_VERSION,
    invoice_issued_cents: toSafeCents(invoice, "invoice_issued_cents"),
    agreed_job_total_cents: state.agreed_job_total_cents ?? null,
    credits_cents: toSafeCents(credits, "credits_cents"),
    effective_payments_cents: toSafeCents(postedPayments, "effective_payments_cents"),
    effective_refunds_cents: toSafeCents(refunds, "effective_refunds_cents"),
    net_received_cents: toSafeCents(netReceived, "net_received_cents"),
    balance_cents: toSafeSignedCents(balance, "balance_cents"),
    amount_due_cents: toSafeCents(amountDue, "amount_due_cents"),
    amount_to_refund_cents: toSafeCents(amountToRefund, "amount_to_refund_cents"),
    payment_status,
    settled_by,
    voided: state.voided,
  };
}

function cloneState(state: LedgerState): LedgerState {
  return {
    invoice_issued_cents: state.invoice_issued_cents,
    credits_cents: state.credits_cents,
    entries: state.entries.map((entry) => ({ ...entry })),
    allocations: state.allocations.map((allocation) => ({ ...allocation })),
    voided: state.voided,
    due_date: state.due_date,
    agreed_job_total_cents: state.agreed_job_total_cents ?? null,
  };
}

export function emptyLedger(input: {
  invoice_issued_cents: number;
  credits_cents?: number;
  due_date?: string | null;
  agreed_job_total_cents?: number | null;
  voided?: boolean;
}): LedgerState {
  return {
    invoice_issued_cents: input.invoice_issued_cents,
    credits_cents: input.credits_cents ?? 0,
    entries: [],
    allocations: [],
    voided: input.voided ?? false,
    due_date: input.due_date ?? null,
    agreed_job_total_cents: input.agreed_job_total_cents ?? null,
  };
}

function assertNewEntryId(state: LedgerState, entryId: string): string {
  const id = requireId(entryId, "entry_id");
  if (state.entries.some((entry) => entry.entry_id === id)) {
    throw domainError("VALIDATION_FAILED", "Ledger entry identifiers must be unique", "entry_id");
  }
  return id;
}

export function applyPayment(
  state: LedgerState,
  input: { entry_id: string; amount_cents: number; confirm_overpayment?: boolean },
): LedgerState {
  const entryId = assertNewEntryId(state, input.entry_id);
  const amount = assertIntegerCents(input.amount_cents, "amount_cents");
  if (amount <= 0n) {
    throw domainError("VALIDATION_FAILED", "Zero entries are prohibited", "amount_cents");
  }
  const next = cloneState(state);
  next.entries = [
    ...next.entries,
    {
      entry_id: entryId,
      type: "payment",
      amount_cents: toSafeCents(amount, "amount_cents"),
      reverses_entry_id: null,
    },
  ];
  const view = deriveLedger(next);
  if (view.balance_cents < 0 && !input.confirm_overpayment) {
    throw domainError("VALIDATION_FAILED", "Overpayments require explicit confirmation", "confirm_overpayment");
  }
  return next;
}

export function applyRefund(state: LedgerState, input: { entry_id: string; amount_cents: number }): LedgerState {
  const entryId = assertNewEntryId(state, input.entry_id);
  const amount = assertIntegerCents(input.amount_cents, "amount_cents");
  if (amount <= 0n) {
    throw domainError("VALIDATION_FAILED", "Zero entries are prohibited", "amount_cents");
  }
  const current = deriveLedger(state);
  if (current.effective_payments_cents <= 0) {
    throw domainError("REFUND_EXCEEDS_BALANCE", "A refund requires effective paid money", "amount_cents");
  }
  if (current.balance_cents >= 0) {
    throw domainError("REFUND_EXCEEDS_BALANCE", "A refund is allowed only when the balance is negative", "amount_cents");
  }
  const outstanding = BigInt(-current.balance_cents);
  const remainingPaid = BigInt(current.net_received_cents);
  if (amount > outstanding || amount > remainingPaid) {
    throw domainError("REFUND_EXCEEDS_BALANCE", "Refund exceeds the outstanding refundable amount", "amount_cents");
  }

  const effective = loadEffective(state);
  let remaining = amount;
  const newAllocations: RefundAllocation[] = [];
  for (const paymentId of effective.paymentOrder) {
    const capacity = effective.effectivePayments.get(paymentId);
    if (capacity === undefined || capacity <= 0n) {
      continue;
    }
    const take = remaining < capacity ? remaining : capacity;
    newAllocations.push({
      refund_entry_id: entryId,
      payment_entry_id: paymentId,
      amount_cents: toSafeCents(take, "amount_cents"),
    });
    remaining -= take;
    if (remaining === 0n) {
      break;
    }
  }
  if (remaining !== 0n) {
    throw domainError("REFUND_EXCEEDS_BALANCE", "Refund exceeds remaining effective payments", "amount_cents");
  }

  const next = cloneState(state);
  next.entries = [
    ...next.entries,
    {
      entry_id: entryId,
      type: "refund",
      amount_cents: toSafeCents(amount, "amount_cents"),
      reverses_entry_id: null,
    },
  ];
  next.allocations = [...next.allocations, ...newAllocations];
  return next;
}

export function applyReversal(state: LedgerState, input: { entry_id: string; reverses_entry_id: string }): LedgerState {
  const entryId = assertNewEntryId(state, input.entry_id);
  const originalId = requireId(input.reverses_entry_id, "reverses_entry_id");
  const original = state.entries.find((entry) => entry.entry_id === originalId);
  if (!original) {
    throw domainError("VALIDATION_FAILED", "Reversal must reference an entry on this invoice", "reverses_entry_id");
  }
  if (original.type === "reversal") {
    throw domainError("VALIDATION_FAILED", "A reversal itself cannot be reversed", "reverses_entry_id");
  }
  const already = state.entries.some((entry) => entry.type === "reversal" && entry.reverses_entry_id === originalId);
  if (already) {
    throw domainError("ENTRY_ALREADY_REVERSED", "An entry can be reversed only once", "reverses_entry_id");
  }
  if (original.type === "payment") {
    const dependent = state.allocations.some((allocation) => {
      if (allocation.payment_entry_id !== originalId) {
        return false;
      }
      const refundReversed = state.entries.some(
        (entry) => entry.type === "reversal" && entry.reverses_entry_id === allocation.refund_entry_id,
      );
      return !refundReversed;
    });
    if (dependent) {
      throw domainError(
        "VALIDATION_FAILED",
        "Reverse dependent refunds before reversing this payment",
        "reverses_entry_id",
      );
    }
  }

  const next = cloneState(state);
  next.entries = [
    ...next.entries,
    {
      entry_id: entryId,
      type: "reversal",
      amount_cents: original.amount_cents,
      reverses_entry_id: originalId,
    },
  ];
  deriveLedger(next);
  return next;
}

export function applyIssuedCredit(state: LedgerState, creditTotalCents: number): LedgerState {
  const credit = assertIntegerCents(creditTotalCents, "credits_cents");
  if (credit <= 0n) {
    throw domainError("VALIDATION_FAILED", "Issued credit total must be positive", "credits_cents");
  }
  const next = cloneState(state);
  next.credits_cents = toSafeCents(BigInt(next.credits_cents) + credit, "credits_cents");
  const issued = assertIntegerCents(next.invoice_issued_cents, "invoice_issued_cents");
  if (BigInt(next.credits_cents) > issued) {
    throw domainError("CREDIT_EXCEEDS_SOURCE", "Issued credits cannot exceed the invoice issued total", "credits_cents");
  }
  return next;
}
