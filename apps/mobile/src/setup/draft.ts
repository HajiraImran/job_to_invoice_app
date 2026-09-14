import type { SetupFormValues } from "./form.ts";

export const SETUP_DRAFT_KEY = "jti.setup.draft";
export const SETUP_DRAFT_SCHEMA = 1 as const;

export type SetupDraft = {
  schema_version: typeof SETUP_DRAFT_SCHEMA;
  workspace_id: string;
  saved_at: string;
  step: 1 | 2 | 3;
  timezone_confirmed: boolean;
  tax_zero_confirmed: boolean;
  skip_logo: boolean;
  values: SetupFormValues;
};

export type DraftStore = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export function parseSetupDraft(raw: string | null, workspaceId: string, setupCompleted: boolean): SetupDraft | undefined {
  if (setupCompleted || !raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as SetupDraft;
    if (parsed.schema_version !== SETUP_DRAFT_SCHEMA) {
      return undefined;
    }
    if (parsed.workspace_id !== workspaceId) {
      return undefined;
    }
    if (!parsed.values || typeof parsed.values !== "object") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function loadSetupDraft(
  store: DraftStore,
  workspaceId: string,
  setupCompleted: boolean,
): Promise<SetupDraft | undefined> {
  const raw = await store.getItem(SETUP_DRAFT_KEY);
  const draft = parseSetupDraft(raw, workspaceId, setupCompleted);
  if (!draft && raw) {
    await store.removeItem(SETUP_DRAFT_KEY);
  }
  return draft;
}

export async function saveSetupDraft(store: DraftStore, draft: SetupDraft): Promise<void> {
  await store.setItem(SETUP_DRAFT_KEY, JSON.stringify(draft));
}

export async function clearSetupDraft(store: DraftStore): Promise<void> {
  await store.removeItem(SETUP_DRAFT_KEY);
}
