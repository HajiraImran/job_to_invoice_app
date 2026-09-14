import type { LineInput } from "./line.ts";

export const FINANCIAL_FIXTURES = {
  F01: {
    id: "F01",
    input: {
      quantity: "2.5",
      unit_price_cents: 10000,
      discount_cents: 1000,
      tax_bp: 825,
    } satisfies LineInput,
    expected: {
      gross_cents: 25000,
      net_cents: 24000,
      tax_cents: 1980,
      total_cents: 25980,
    },
  },
  F02: {
    id: "F02",
    input: {
      quantity: "0.333",
      unit_price_cents: 1000,
      discount_cents: 0,
      tax_bp: 0,
    } satisfies LineInput,
    expected: {
      gross_cents: 333,
      net_cents: 333,
      tax_cents: 0,
      total_cents: 333,
    },
  },
  F03: {
    id: "F03",
    net_cents: 5,
    tax_bp: 1000,
    expected: {
      tax_cents: 1,
      total_cents: 6,
    },
  },
  F04: {
    id: "F04",
    addition: {
      quantity: "1",
      unit_price_cents: 10000,
      discount_cents: 0,
      tax_bp: 825,
    } satisfies LineInput,
    expected: {
      change_including_tax_cents: 10825,
      new_agreed_total_cents: 36805,
    },
  },
  F05: {
    id: "F05",
    original_net_cents: 100,
    original_tax_cents: 8,
    reductions_cents: [33, 33, 34],
    expected_tax_reductions_cents: [3, 2, 3],
    expected_remaining_net_cents: 0,
    expected_remaining_tax_cents: 0,
  },
  F06: {
    id: "F06",
    remaining_net_cents: 34,
    requested_net_cents: 35,
    error_code: "CREDIT_EXCEEDS_SOURCE",
  },
  F07: {
    id: "F07",
    invoice_issued_cents: 10000,
    payment_cents: 4000,
    expected: {
      amount_due_cents: 6000,
      payment_status: "partially_paid",
    },
  },
  F08: {
    id: "F08",
    invoice_issued_cents: 10000,
    payment_cents: 10000,
    credit_cents: 2000,
    expected: {
      balance_cents: -2000,
      payment_status: "refund_due",
    },
  },
  F09: {
    id: "F09",
    refund_cents: 2000,
    expected: {
      balance_cents: 0,
      payment_status: "settled",
    },
  },
  F10: {
    id: "F10",
    invoice_issued_cents: 10000,
    payment_cents: 12000,
    expected: {
      balance_cents: -2000,
      payment_status: "refund_due",
    },
  },
  F11: {
    id: "F11",
    invoice_issued_cents: 10000,
    payment_cents: 4000,
    expected: {
      balance_cents: 10000,
      payment_status: "issued_unpaid",
    },
  },
  F12: {
    id: "F12",
    expected: {
      invoice_issued_cents: 0,
      balance_cents: 0,
      payment_status: "settled",
      settled_by: "zero_invoice",
    },
  },
} as const;
