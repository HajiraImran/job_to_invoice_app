import { retainOrCreateSetupIdempotencyKey } from "../setup/idempotency.ts";
import { jobDetailPath } from "../jobs/routes.ts";
import { quotePublishBody } from "./form.ts";

export type QuotePublishPreview = {
  draft_id: string;
  job_id: string;
  preview_hash: string;
  version: number;
};

export type QuotePublishRequest = {
  path: string;
  method: "POST";
  body: { preview_hash: string; recipient_email: string };
  idempotencyKey: string;
  ifMatch: number;
};

export type ConfirmedQuotePublishStart =
  | { kind: "ignored" }
  | { kind: "invalid_email" }
  | { kind: "request"; request: QuotePublishRequest; idempotencyKey: string };

export function beginConfirmedQuotePublish(input: {
  confirming: boolean;
  cancelled?: boolean;
  preview?: QuotePublishPreview;
  recipientEmail: string;
  inFlight: { current: boolean };
  idempotencyKey: string | undefined;
}): ConfirmedQuotePublishStart {
  if (input.cancelled || !input.confirming || !input.preview || input.inFlight.current) {
    return { kind: "ignored" };
  }
  const body = quotePublishBody(input.preview.preview_hash, input.recipientEmail);
  if (!body.ok) {
    return { kind: "invalid_email" };
  }
  input.inFlight.current = true;
  const idempotencyKey = retainOrCreateSetupIdempotencyKey(input.idempotencyKey);
  return {
    kind: "request",
    idempotencyKey,
    request: {
      path: `/v1/drafts/${input.preview.draft_id}/publish`,
      method: "POST",
      body: body.value,
      idempotencyKey,
      ifMatch: input.preview.version,
    },
  };
}

export function quotePublishSuccessPath(jobId: string): string {
  return jobDetailPath(jobId);
}

export async function executeConfirmedQuotePublish<T extends { number: string }>(input: {
  confirming: boolean;
  cancelled?: boolean;
  preview?: QuotePublishPreview;
  recipientEmail: string;
  inFlight: { current: boolean };
  idempotencyKey: { current: string | undefined };
  publish: (
    request: QuotePublishRequest,
  ) => Promise<{ ok: true; data: T } | { ok: false }>;
}): Promise<{
  requests: QuotePublishRequest[];
  navigatedTo?: string;
  stayedOnPublish: boolean;
  feedback?: "invalid_email" | "api_error";
  publishedNumber?: string;
}> {
  const started = beginConfirmedQuotePublish({
    confirming: input.confirming,
    cancelled: input.cancelled,
    preview: input.preview,
    recipientEmail: input.recipientEmail,
    inFlight: input.inFlight,
    idempotencyKey: input.idempotencyKey.current,
  });
  if (started.kind === "ignored") {
    return { requests: [], stayedOnPublish: true };
  }
  if (started.kind === "invalid_email") {
    return { requests: [], stayedOnPublish: true, feedback: "invalid_email" };
  }
  input.idempotencyKey.current = started.idempotencyKey;
  try {
    const result = await input.publish(started.request);
    if (result.ok && input.preview) {
      return {
        requests: [started.request],
        navigatedTo: quotePublishSuccessPath(input.preview.job_id),
        stayedOnPublish: false,
        publishedNumber: result.data.number,
      };
    }
    return { requests: [started.request], stayedOnPublish: true, feedback: "api_error" };
  } finally {
    input.inFlight.current = false;
  }
}
