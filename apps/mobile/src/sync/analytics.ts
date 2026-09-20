/** Safe client analytics for S23. Never attach commercial payloads. */

export type SyncConflictAnalyticsProps = {
  resource_kind: "draft" | "job";
  client_version: string;
};

export function buildSyncConflictAnalytics(input: {
  resourceKind: "draft" | "job";
  clientVersion: string;
}): SyncConflictAnalyticsProps {
  return {
    resource_kind: input.resourceKind,
    client_version: input.clientVersion,
  };
}

export function syncConflictAnalyticsIsSafe(
  props: Record<string, unknown>,
  forbiddenFragments: readonly string[],
): boolean {
  const keys = Object.keys(props).sort();
  if (keys.join(",") !== "client_version,resource_kind") {
    return false;
  }
  const serialized = JSON.stringify(props);
  return !forbiddenFragments.some((fragment) => fragment.length > 0 && serialized.includes(fragment));
}
