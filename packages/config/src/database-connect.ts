export const DATABASE_CONNECT_ATTEMPT_TIMEOUT_DEFAULT_MS = 2_000;
export const DATABASE_CONNECT_DEADLINE_DEFAULT_MS = 5_500;
export const DATABASE_CONNECT_ATTEMPT_TIMEOUT_MAX_MS = 30_000;
export const DATABASE_CONNECT_DEADLINE_MAX_MS = 90_000;

export type DatabaseConnectTimeouts = {
  databaseConnectAttemptTimeoutMs: number;
  databaseConnectDeadlineMs: number;
};

function parsePositiveInt(name: string, raw: string | undefined, max: number): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || !Number.isFinite(value) || value < 1 || value > max) {
    throw new Error(`${name} must be 1–${max}`);
  }
  return value;
}

export function resolveDatabaseConnectTimeouts(
  source: NodeJS.Dict<string>,
  appEnv = "development",
): DatabaseConnectTimeouts {
  try {
    const attempt =
      parsePositiveInt(
        "DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS",
        source.DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS,
        DATABASE_CONNECT_ATTEMPT_TIMEOUT_MAX_MS,
      ) ?? DATABASE_CONNECT_ATTEMPT_TIMEOUT_DEFAULT_MS;
    const deadline =
      parsePositiveInt(
        "DATABASE_CONNECT_DEADLINE_MS",
        source.DATABASE_CONNECT_DEADLINE_MS,
        DATABASE_CONNECT_DEADLINE_MAX_MS,
      ) ?? DATABASE_CONNECT_DEADLINE_DEFAULT_MS;
    if (deadline < attempt) {
      throw new Error(
        "DATABASE_CONNECT_DEADLINE_MS must be greater than or equal to DATABASE_CONNECT_ATTEMPT_TIMEOUT_MS",
      );
    }
    return {
      databaseConnectAttemptTimeoutMs: attempt,
      databaseConnectDeadlineMs: deadline,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid database connect timeouts";
    throw new Error(`Invalid ${appEnv} configuration (QA68): ${message}`, { cause: error });
  }
}
