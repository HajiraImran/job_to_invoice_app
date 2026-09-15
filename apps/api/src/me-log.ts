export const OWNER_ME_EVENT = "owner_me";

export const OWNER_ME_STAGES = [
  "request_received",
  "jwt_rejected",
  "jwt_verified",
  "database_connect_failed",
  "transaction_start_failed",
  "set_role_failed",
  "provision_owner_failed",
  "bootstrap_query_failed",
  "database_or_provisioning_failed",
  "response_sent",
] as const;

export type OwnerMeStage = (typeof OWNER_ME_STAGES)[number];

export const OWNER_ME_SAFE_KEYS = ["event", "request_id", "status", "stage"] as const;
export const OWNER_ME_OPTIONAL_KEYS = ["sqlstate"] as const;

export type OwnerMeSafeEvent = {
  event: typeof OWNER_ME_EVENT;
  request_id: string;
  status: number;
  stage: OwnerMeStage;
  sqlstate?: string;
};

const STAGE_SET = new Set<string>(OWNER_ME_STAGES);
const SQLSTATE_PATTERN = /^(08|0A|22|23|25|28|40|42|53|54|55|57|58|P0|XX)[0-9A-Z]{3}$/;

export function allowlistedSqlstate(value: unknown): string | undefined {
  if (typeof value !== "string" || !SQLSTATE_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

const STAGE_SET_FOR_KEYS = new Set<string>([...OWNER_ME_SAFE_KEYS, ...OWNER_ME_OPTIONAL_KEYS]);

export function ownerMeSafeEvent(input: {
  request_id: string;
  status: number;
  stage: OwnerMeStage;
  sqlstate?: string;
}): OwnerMeSafeEvent {
  const event: OwnerMeSafeEvent = {
    event: OWNER_ME_EVENT,
    request_id: input.request_id,
    status: input.status,
    stage: input.stage,
  };
  const sqlstate = allowlistedSqlstate(input.sqlstate);
  if (sqlstate) {
    event.sqlstate = sqlstate;
  }
  return event;
}

export function ownerMeEventHasOnlySafeFields(value: unknown): value is OwnerMeSafeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !STAGE_SET_FOR_KEYS.has(key))) {
    return false;
  }
  if (!OWNER_ME_SAFE_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  if (record.sqlstate !== undefined && allowlistedSqlstate(record.sqlstate) !== record.sqlstate) {
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
