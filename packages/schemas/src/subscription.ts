export const TRIAL_DAYS = 14;
export const TRIAL_JOB_LIMIT = 20;

export type TrialStartParseResult =
  | { ok: true; value: { acknowledged: true } }
  | { ok: false; field_errors: { field: string; message: string }[] };

export function parseTrialStart(raw: unknown): TrialStartParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field_errors: [{ field: "body", message: "A JSON object is required." }] };
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "acknowledged")) {
    return { ok: false, field_errors: [{ field: "body", message: "Unknown fields are not allowed." }] };
  }
  if (body.acknowledged !== true) {
    return {
      ok: false,
      field_errors: [{ field: "acknowledged", message: "Confirm you are starting the 14 day trial." }],
    };
  }
  return { ok: true, value: { acknowledged: true } };
}

export function trialIsActive(input: {
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialJobsConsumed: number;
  nowMs: number;
}): boolean {
  if (!input.trialStartedAt || !input.trialEndsAt) {
    return false;
  }
  const ends = Date.parse(input.trialEndsAt);
  if (Number.isNaN(ends)) {
    return false;
  }
  return input.nowMs < ends && input.trialJobsConsumed < TRIAL_JOB_LIMIT;
}

export function canPublishFromAllowance(input: {
  freeJobsConsumed: number;
  freeJobLimit: number;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
  trialJobsConsumed: number;
  nowMs: number;
}): boolean {
  if (input.freeJobsConsumed < input.freeJobLimit) {
    return true;
  }
  return trialIsActive(input);
}
