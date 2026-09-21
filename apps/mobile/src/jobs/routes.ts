export function jobsIndexPath(): string {
  return "/(tabs)/jobs";
}

export function createJobPath(): string {
  return "/(tabs)/jobs/new";
}

export function jobDetailPath(jobId: string): string {
  return `/(tabs)/jobs/${jobId}`;
}

export function jobQuotePath(jobId: string): string {
  return `/(tabs)/jobs/${jobId}/quote`;
}

export function jobPublishPath(jobId: string): string {
  return `/(tabs)/jobs/${jobId}/publish`;
}

export function jobRequestPath(jobId: string): string {
  return `/(tabs)/jobs/${jobId}/request`;
}

export function jobInvoicePath(jobId: string): string {
  return `/(tabs)/jobs/${jobId}/invoice`;
}

export function jobInvoiceDetailPath(jobId: string, invoiceId: string): string {
  return `/(tabs)/jobs/${jobId}/invoice/${invoiceId}`;
}

export function jobLedgerEntryPath(jobId: string, invoiceId: string, kind: "payment" | "refund"): string {
  return `/(tabs)/jobs/${jobId}/ledger/entry?invoiceId=${encodeURIComponent(invoiceId)}&kind=${kind}`;
}

export function canOpenCreateJob(status: string): boolean {
  return status === "authenticated" || status === "offline_cached";
}

export function createJobDisabled(status: string, submitting: boolean): boolean {
  return submitting || status === "access_expired";
}
