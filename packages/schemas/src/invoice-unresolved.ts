export type InvoiceUnresolvedBlocker = {
  kind: "change_draft" | "pending_approval";
  document_kind?: string | null;
  number?: string | null;
  revision_no?: number | null;
};

export type InvoiceUnresolvedFieldError = { field: string; message: string };

export const UNRESOLVED_INVOICE_FALLBACK =
  "Resolve pending changes or approvals before issuing this invoice.";

export function documentRevisionLabel(number: string, revisionNo: number): string {
  return `${number} R${revisionNo}`;
}

function pendingKindLabel(blocker: InvoiceUnresolvedBlocker): string {
  if (blocker.document_kind === "quote") {
    return "The quote";
  }
  if (blocker.document_kind === "change") {
    return "The extra-work request";
  }
  return "A customer approval";
}

export function unresolvedInvoiceMessage(blockers: readonly InvoiceUnresolvedBlocker[]): string {
  const draft = blockers.some((row) => row.kind === "change_draft");
  const pending = blockers.find((row) => row.kind === "pending_approval");
  if (draft && pending) {
    return `This job has unpublished extra work, and ${pendingKindLabel(pending)} is still waiting for the customer to approve it. Finish or discard the extra work, and wait for that decision, before invoicing.`;
  }
  if (draft) {
    return "This job has unpublished extra work. Open Extra work to finish sending it for approval, or discard that draft before invoicing.";
  }
  if (pending) {
    return `${pendingKindLabel(pending)} is still waiting for the customer to approve it. Wait for that decision before invoicing.`;
  }
  return UNRESOLVED_INVOICE_FALLBACK;
}

export function unresolvedInvoiceFieldErrors(
  blockers: readonly InvoiceUnresolvedBlocker[],
): InvoiceUnresolvedFieldError[] {
  return blockers.map((row) => {
    if (row.kind === "change_draft") {
      return {
        field: "change_draft",
        message: "Finish or discard the unpublished extra work before invoicing.",
      };
    }
    return {
      field: "approval_request",
      message: "Wait for the customer to approve the pending request before invoicing.",
    };
  });
}
