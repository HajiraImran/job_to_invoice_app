export type SubscriptionRecord = {
  source: string;
  can_publish: boolean;
  can_start_trial: boolean;
  free_jobs_consumed: number;
  free_jobs_remaining: number;
  trial: null | {
    started_at: string | null;
    ends_at: string | null;
    jobs_consumed: number;
    jobs_remaining: number;
    active: boolean;
  };
};

export type SubscriptionViewKind = "loading" | "offline" | "access_expired" | "error" | "ready" | "starting";

export function presentSubscription(input: {
  authStatus: string;
  loading: boolean;
  starting: boolean;
  subscription?: SubscriptionRecord;
  error?: string;
}): { kind: SubscriptionViewKind; startDisabled: boolean; message?: string } {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", startDisabled: true };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", startDisabled: true, message: input.error };
  }
  if (input.starting) {
    return { kind: "starting", startDisabled: true };
  }
  if (input.loading && !input.subscription) {
    return { kind: "loading", startDisabled: true };
  }
  if (input.error && !input.subscription) {
    return { kind: "error", startDisabled: true, message: input.error };
  }
  return {
    kind: "ready",
    startDisabled: !input.subscription?.can_start_trial,
    message: input.error,
  };
}

export function paywallViewedProperties(entryPoint: "settings" | "publish"): { entry_point: string } {
  return { entry_point: entryPoint };
}

export function subscriptionPath(): string {
  return "/(tabs)/settings/subscription";
}
