export const portalCopy = {
  appName: "Job to Invoice",
  loading: "Loading this quote.",
  requestCode: "Send verification code",
  sendingCode: "Sending code",
  enterCode: "Enter the 6-digit code",
  verify: "Verify",
  verifying: "Verifying",
  resend: "Resend code",
  incorrectCode: "That code didn't work. Try again.",
  expiredCode: "That code has expired. Request a new one.",
  tooManyAttempts: "Too many attempts. Request a new code.",
  resendCooldown: "Wait before requesting another code.",
  networkError: "Could not reach the network. Try again.",
  identifierError: "Could not start this request. Try again.",
  invalidLink: "This review link is no longer available.",
  expiredQuote: "This request has expired. Ask the business for a new version.",
  supersededQuote: "A newer version is available. This version cannot be approved.",
  quoteReady: "Review this quote",
  changeReady: "Review this change order",
  invoiceReady: "View this invoice",
  pdfLoading: "Preparing the official PDF.",
  pdfFailure: "The official PDF is not ready. Approve is unavailable until it is.",
  consentLabel: "I confirm I have reviewed this quote, including the PDF, and I am authorized to approve or decline it. This is not a payment.",
  signerName: "Your name",
  approve: "Approve",
  decline: "Request changes",
  confirmAccept: "Approve this quote?",
  confirmChangeAccept: "Approve this change order?",
  confirmReject: "Decline this quote?",
  confirmChangeReject: "Decline this change order?",
  commentLabel: "Comment (optional, 1000 characters)",
  submitting: "Saving your decision",
  accepted: "You accepted this quote. This is not a payment.",
  changeAccepted: "You accepted this change order. This is not a payment.",
  rejected: "You declined this quote.",
  changeRejected: "You declined this change order.",
  alreadyActioned: "This quote has already been actioned.",
  changeAlreadyActioned: "This change order has already been actioned.",
  previousTotal: "Previously agreed total",
  changeTotal: "Change including tax",
  newAgreedTotal: "New agreed total",
  downloadPdf: "Download PDF",
  downloadError: "The PDF could not be opened. Try again.",
  report: "Report a problem",
  retry: "Try again",
} as const;

export const CONSENT_VERSION = "apr04.v1";

export function readFragmentToken(hash: string): string | undefined {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!value || value.includes("=") || value.includes("&") || value.length < 40 || value.length > 64) {
    return undefined;
  }
  return value;
}

export type PortalKind =
  | "loading"
  | "awaiting_verification"
  | "code_sent"
  | "incorrect_code"
  | "expired_code"
  | "too_many_attempts"
  | "resend_cooldown"
  | "network_failure"
  | "invalid_link"
  | "expired_quote"
  | "superseded"
  | "quote_ready"
  | "invoice_ready"
  | "pdf_loading"
  | "pdf_failure"
  | "confirm_accept"
  | "confirm_reject"
  | "submitting"
  | "accepted"
  | "rejected"
  | "already_actioned";

export function accessStateKind(accessState: string | undefined): PortalKind {
  if (accessState === "expired") {
    return "expired_quote";
  }
  if (accessState === "superseded") {
    return "superseded";
  }
  if (accessState === "unavailable" || !accessState) {
    return "invalid_link";
  }
  if (accessState === "decided") {
    return "already_actioned";
  }
  return "awaiting_verification";
}

export function codeErrorKind(code: string | undefined, status: number): PortalKind {
  if (status === 0 || status >= 500) {
    return "network_failure";
  }
  if (status === 429) {
    return "too_many_attempts";
  }
  if (code === "RATE_LIMITED") {
    return "resend_cooldown";
  }
  if (status === 404 || code === "REQUEST_UNAVAILABLE") {
    return "invalid_link";
  }
  if (code === "REQUEST_EXPIRED") {
    return "expired_quote";
  }
  return "incorrect_code";
}

export function documentKind(input: {
  accessState?: string;
  pdfState?: string;
  allowedActions?: string[];
}): PortalKind {
  if (input.accessState === "expired") {
    return "expired_quote";
  }
  if (input.accessState === "superseded") {
    return "superseded";
  }
  if (input.accessState === "decided") {
    return "already_actioned";
  }
  if (input.accessState !== "pending") {
    return "invalid_link";
  }
  if (input.pdfState === "failed") {
    return "pdf_failure";
  }
  if (input.pdfState !== "ready") {
    return "pdf_loading";
  }
  if ((input.allowedActions ?? ["approve"]).includes("approve")) {
    return "quote_ready";
  }
  return "invoice_ready";
}

export function canApprove(kind: PortalKind, consentAccepted: boolean, pdfReady: boolean): boolean {
  return kind === "quote_ready" && consentAccepted && pdfReady;
}
