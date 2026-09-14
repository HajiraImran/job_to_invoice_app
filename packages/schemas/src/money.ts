export const MONEY_SCHEMA_VERSION = 1 as const;

export const MONEY_ERROR_CODES = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  CREDIT_EXCEEDS_SOURCE: "CREDIT_EXCEEDS_SOURCE",
  REFUND_EXCEEDS_BALANCE: "REFUND_EXCEEDS_BALANCE",
  ENTRY_ALREADY_REVERSED: "ENTRY_ALREADY_REVERSED",
} as const;

export type MoneySchemaVersion = typeof MONEY_SCHEMA_VERSION;
export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[keyof typeof MONEY_ERROR_CODES];

export type LineInputV1 = {
  schema_version?: MoneySchemaVersion;
  client_line_id?: string | null;
  quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
};

export type LineResultV1 = {
  schema_version: MoneySchemaVersion;
  client_line_id: string | null;
  quantity: string;
  unit_price_cents: number;
  discount_cents: number;
  tax_bp: number;
  gross_cents: number;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export type TaxRateSummaryV1 = {
  tax_bp: number;
  net_cents: number;
  tax_cents: number;
};

export type DocumentTotalsV1 = {
  schema_version: MoneySchemaVersion;
  lines: LineResultV1[];
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  tax_by_rate: TaxRateSummaryV1[];
};

export type SourceLineInputV1 = {
  schema_version?: MoneySchemaVersion;
  source_line_id: string;
  original_net_cents: number;
  original_tax_cents: number;
  accepted_net_reductions_cents: number;
};

export type ReductionResultV1 = {
  schema_version: MoneySchemaVersion;
  source_line_id: string;
  net_reduction_cents: number;
  tax_reduction_cents: number;
  total_reduction_cents: number;
  remaining_net_cents: number;
  remaining_tax_cents: number;
  cumulative_net_reductions_cents: number;
};

export type ChangeOrderInputV1 = {
  schema_version?: MoneySchemaVersion;
  previous_total_cents: number;
  additions: LineInputV1[];
  reductions: Array<{ source_line_id: string; net_credit_cents: number }>;
  sources: SourceLineInputV1[];
  reason?: string | null;
};

export type ChangeOrderResultV1 = {
  schema_version: MoneySchemaVersion;
  previous_total_cents: number;
  addition_net_cents: number;
  addition_tax_cents: number;
  addition_total_cents: number;
  reduction_net_cents: number;
  reduction_tax_cents: number;
  reduction_total_cents: number;
  change_including_tax_cents: number;
  new_agreed_total_cents: number;
  additions: LineResultV1[];
  reductions: ReductionResultV1[];
  reason: string | null;
};

export type ResidualInvoiceLineInputV1 = {
  source_line_id: string;
  residual_net_cents: number;
  residual_tax_cents: number;
};

export type InvoiceLineResultV1 = {
  source_line_id: string;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
};

export type InvoiceTotalsV1 = {
  schema_version: MoneySchemaVersion;
  agreed_job_total_cents: number;
  invoice_issued_cents: number;
  credits_cents: number;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  lines: InvoiceLineResultV1[];
};

export type CreditAllocationInputV1 = {
  invoice_line_id: string;
  net_credit_cents: number;
};

export type InvoiceCreditLineInputV1 = {
  invoice_line_id: string;
  residual_net_cents: number;
  residual_tax_cents: number;
  credited_net_cents: number;
};

export type CreditResultV1 = {
  schema_version: MoneySchemaVersion;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  allocations: ReductionResultV1[];
};

export type PaymentStatusV1 = "issued_unpaid" | "partially_paid" | "settled" | "overdue" | "refund_due";
export type SettledByV1 = "payment" | "credit" | "zero_invoice" | "mixed" | null;
export type LedgerEntryTypeV1 = "payment" | "refund" | "reversal";

export type LedgerEntryV1 = {
  entry_id: string;
  type: LedgerEntryTypeV1;
  amount_cents: number;
  reverses_entry_id: string | null;
};

export type RefundAllocationV1 = {
  refund_entry_id: string;
  payment_entry_id: string;
  amount_cents: number;
};

export type LedgerStateV1 = {
  schema_version?: MoneySchemaVersion;
  invoice_issued_cents: number;
  credits_cents: number;
  entries: LedgerEntryV1[];
  allocations: RefundAllocationV1[];
  voided: boolean;
  due_date: string | null;
};

export type LedgerViewV1 = {
  schema_version: MoneySchemaVersion;
  invoice_issued_cents: number;
  agreed_job_total_cents: number | null;
  credits_cents: number;
  effective_payments_cents: number;
  effective_refunds_cents: number;
  net_received_cents: number;
  balance_cents: number;
  amount_due_cents: number;
  amount_to_refund_cents: number;
  payment_status: PaymentStatusV1;
  settled_by: SettledByV1;
  voided: boolean;
};
