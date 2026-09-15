export const OWNER_ME_EVENT = "owner_me";

export const OWNER_ME_STAGES = [
  "request_received",
  "jwt_rejected",
  "jwt_verified",
  "database_or_provisioning_failed",
  "response_sent",
] as const;

export type OwnerMeStage = (typeof OWNER_ME_STAGES)[number];

export const OWNER_ME_SAFE_KEYS = ["event", "request_id", "status", "stage"] as const;

export type OwnerMeSafeEvent = {
  event: typeof OWNER_ME_EVENT;
  request_id: string;
  status: number;
  stage: OwnerMeStage;
};

const STAGE_SET = new Set<string>(OWNER_ME_STAGES);

export function ownerMeSafeEvent(input: {
  request_id: string;
  status: number;
  stage: OwnerMeStage;
}): OwnerMeSafeEvent {
  return {
    event: OWNER_ME_EVENT,
    request_id: input.request_id,
    status: input.status,
    stage: input.stage,
  };
}

export function ownerMeEventHasOnlySafeFields(value: unknown): value is OwnerMeSafeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== OWNER_ME_SAFE_KEYS.length) {
    return false;
  }
  if (!OWNER_ME_SAFE_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  return (
    record.event === OWNER_ME_EVENT &&
    typeof record.request_id === "string" &&
    typeof record.status === "number" &&
    Number.isFinite(record.status) &&
    typeof record.stage === "string" &&
    STAGE_SET.has(record.stage)
  );
}

export function writeOwnerMeEvent(event: OwnerMeSafeEvent, write: (line: string) => void = console.log): void {
  write(JSON.stringify(ownerMeSafeEvent(event)));
}
