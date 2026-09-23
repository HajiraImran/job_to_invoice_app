export type DeletionRecord = {
  id: string;
  status: "locked" | "purging" | "completed" | "exception" | string;
  requested_at: string | null;
  verified_at: string | null;
  purge_after: string | null;
  purge_deadline: string | null;
  completed_at: string | null;
  retained_categories: unknown[];
};

export type DeletionViewKind =
  | "offline"
  | "access_expired"
  | "step_up"
  | "working"
  | "locked"
  | "ready"
  | "error";

export function presentDeletion(input: {
  authStatus: string;
  accountStatus?: string;
  requesting: boolean;
  stepUp: boolean;
  confirmation: string;
  record?: DeletionRecord | null;
  error?: string;
}): { kind: DeletionViewKind; confirmDisabled: boolean; message?: string } {
  if (input.authStatus === "access_expired") {
    return { kind: "access_expired", confirmDisabled: true };
  }
  if (input.authStatus === "offline_cached") {
    return { kind: "offline", confirmDisabled: true, message: input.error };
  }
  if (input.record || input.accountStatus === "deleting") {
    return { kind: "locked", confirmDisabled: true, message: input.error };
  }
  if (input.stepUp) {
    return { kind: "step_up", confirmDisabled: true, message: input.error };
  }
  if (input.requesting) {
    return { kind: "working", confirmDisabled: true };
  }
  if (input.error) {
    return { kind: "error", confirmDisabled: input.confirmation !== "DELETE", message: input.error };
  }
  return { kind: "ready", confirmDisabled: input.confirmation !== "DELETE", message: input.error };
}

export function deletionStatusLabel(status: string): string {
  switch (status) {
    case "locked":
      return "Account locked. Removal of live records has started.";
    case "purging":
      return "Removing live records and stored files.";
    case "completed":
      return "Live records have been removed.";
    case "exception":
      return "Deletion needs support attention.";
    default:
      return "No deletion request.";
  }
}
