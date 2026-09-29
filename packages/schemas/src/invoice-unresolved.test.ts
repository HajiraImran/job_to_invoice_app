import { describe, expect, it } from "vitest";
import {
  documentRevisionLabel,
  unresolvedInvoiceFieldErrors,
  unresolvedInvoiceMessage,
  UNRESOLVED_INVOICE_FALLBACK,
} from "./invoice-unresolved.ts";

describe("unresolved invoice copy", () => {
  it("identifies an unpublished change draft without treating an accepted change as pending", () => {
    expect(
      unresolvedInvoiceMessage([{ kind: "change_draft" }]),
    ).toBe(
      "This job has unpublished extra work. Open Extra work to finish sending it for approval, or discard that draft before invoicing.",
    );
    expect(
      unresolvedInvoiceMessage([
        {
          kind: "pending_approval",
          document_kind: "change",
          number: "CO-000001",
          revision_no: 1,
        },
      ]),
    ).toBe(
      "The extra-work request is still waiting for the customer to approve it. Wait for that decision before invoicing.",
    );
    expect(unresolvedInvoiceMessage([])).toBe(UNRESOLVED_INVOICE_FALLBACK);
    expect(documentRevisionLabel("CO-000001", 1)).toBe("CO-000001 R1");
    expect(unresolvedInvoiceFieldErrors([{ kind: "change_draft" }])).toEqual([
      { field: "change_draft", message: "Finish or discard the unpublished extra work before invoicing." },
    ]);
  });
});
