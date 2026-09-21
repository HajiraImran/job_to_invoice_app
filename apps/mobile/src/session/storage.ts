export type SecureKv = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export const SESSION_STORAGE_KEY = "jti.supabase.session";
export const LAST_AUTH_KEY = "jti.auth.last_success_at";
export const BOOTSTRAP_KEY = "jti.auth.bootstrap";
export const PENDING_REPLACE_KEY = "jti.pending.replace_link";

export async function clearAuthMaterial(storage: SecureKv): Promise<void> {
  await storage.removeItem(SESSION_STORAGE_KEY);
  await storage.removeItem(LAST_AUTH_KEY);
  await storage.removeItem(BOOTSTRAP_KEY);
  await storage.removeItem(PENDING_REPLACE_KEY);
}
