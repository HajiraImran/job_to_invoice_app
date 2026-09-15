import { OTP_MAX_FAILURES, remainingResendSeconds, type AuthSnapshot } from "@job-to-invoice/schemas";
import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { ownerRequest, type OwnerBootstrap, type OwnerRequestOptions } from "../api/client.ts";
import { publicConfig } from "../config.ts";
import { discardLocalDrafts, getDraftSyncStatus } from "../drafts/sync.ts";
import { mapAuthError } from "../auth/errors.ts";
import { copy } from "../i18n/en.ts";
import {
  bootstrapErrorCopy,
  classifyOwnerMeError,
  fetchOwnerMeWithOneRefresh,
  snapshotAfterBootstrapFailure,
} from "./bootstrap.ts";
import { awaitingCodeSnapshot, snapshotFromBootstrap } from "./logic.ts";
import { createOwnerAuthClient, secureKv } from "./supabase.ts";
import { BOOTSTRAP_KEY, LAST_AUTH_KEY, clearAuthMaterial } from "./storage.ts";

type AuthContextValue = {
  snapshot: AuthSnapshot;
  bootstrap?: OwnerBootstrap;
  emailDisplay: string;
  code: string;
  setEmailDisplay: (value: string) => void;
  setCode: (value: string) => void;
  error?: string;
  submitting: boolean;
  resendSeconds: number;
  configured: boolean;
  sendCode: () => Promise<void>;
  verifyCode: () => Promise<void>;
  changeEmail: () => void;
  signOut: (mode: "confirm" | "discard") => Promise<void>;
  draftStatus: () => ReturnType<typeof getDraftSyncStatus>;
  refreshBootstrap: () => Promise<void>;
  runOwnerRequest: <T>(options: OwnerRequestOptions) => ReturnType<typeof ownerRequest<T>>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const config = publicConfig();
  const configured = Boolean(config.authProjectUrl && config.authPublishableKey);
  const client = useMemo(
    () => (configured ? createOwnerAuthClient(config.authProjectUrl, config.authPublishableKey) : null),
    [configured, config.authProjectUrl, config.authPublishableKey],
  );
  const [snapshot, setSnapshot] = useState<AuthSnapshot>({ status: "restoring" });
  const [bootstrap, setBootstrap] = useState<OwnerBootstrap | undefined>();
  const [emailDisplay, setEmailDisplay] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());

  const persistBootstrap = useCallback(async (next: OwnerBootstrap, authenticatedAt: string) => {
    setBootstrap(next);
    await secureKv.setItem(BOOTSTRAP_KEY, JSON.stringify(next));
    await secureKv.setItem(LAST_AUTH_KEY, authenticatedAt);
    setSnapshot(snapshotFromBootstrap(next, authenticatedAt));
    setError(undefined);
  }, []);

  const loadMe = useCallback(
    async (session: Session, emailHint?: string) => {
      const result = await fetchOwnerMeWithOneRefresh({
        accessToken: session.access_token,
        fetchMe: (accessToken) =>
          ownerRequest<OwnerBootstrap>({
            apiBaseUrl: config.apiBaseUrl,
            path: "/v1/me",
            accessToken,
          }),
        refresh: async () => {
          if (!client) {
            return undefined;
          }
          const refreshed = await client.auth.refreshSession();
          return refreshed.data.session?.access_token;
        },
      });
      if (result.ok) {
        await persistBootstrap(result.data, new Date().toISOString());
        return;
      }
      const last = (await secureKv.getItem(LAST_AUTH_KEY)) ?? undefined;
      const cached = await secureKv.getItem(BOOTSTRAP_KEY);
      const kind = classifyOwnerMeError(result.error);
      const nextSnap = snapshotAfterBootstrapFailure({
        kind,
        emailDisplay: emailHint?.trim() || undefined,
        lastAuthenticatedAt: last,
        nowMs: Date.now(),
        hasCachedBootstrap: Boolean(cached),
      });
      if (nextSnap.status === "offline_cached" && cached) {
        try {
          const parsed = JSON.parse(cached) as OwnerBootstrap;
          setBootstrap(parsed);
          setSnapshot({
            ...nextSnap,
            setupCompleted: parsed.workspace.setup_completed,
            emailDisplay: parsed.user.display_email,
          });
          return;
        } catch {
          /* fall through to bootstrap_error */
        }
      }
      setSnapshot({
        ...nextSnap,
        status: nextSnap.status === "access_expired" ? "access_expired" : "bootstrap_error",
        emailDisplay: nextSnap.emailDisplay ?? (emailHint?.trim() || undefined),
      });
      if (nextSnap.status !== "access_expired") {
        setError(copy[bootstrapErrorCopy(kind)]);
      }
    },
    [client, config.apiBaseUrl, persistBootstrap],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!client) {
        if (!cancelled) {
          setSnapshot({ status: "signed_out" });
        }
        return;
      }
      const existing = await client.auth.getSession();
      if (cancelled) {
        return;
      }
      if (existing.data.session) {
        try {
          await loadMe(existing.data.session, existing.data.session.user.email);
        } catch {
          if (!cancelled) {
            setSnapshot({
              status: "bootstrap_error",
              emailDisplay: existing.data.session.user.email,
            });
            setError(copy.bootstrapUnavailable);
          }
        }
      } else {
        setSnapshot({ status: "signed_out" });
      }
    })().catch(() => {
      if (!cancelled) {
        setSnapshot({ status: "signed_out" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, loadMe]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNow(Date.now());
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (snapshot.status !== "awaiting_code") {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.status]);

  const sendCode = useCallback(async () => {
    setError(undefined);
    if (!client) {
      setError("Authentication is not configured on this build.");
      return;
    }
    setSubmitting(true);
    try {
      const { error: sendError } = await client.auth.signInWithOtp({
        email: emailDisplay.trim(),
        options: { shouldCreateUser: true },
      });
      if (sendError) {
        const kind = mapAuthError(sendError);
        if (kind === "throttled") {
          setError("Wait before requesting another code.");
          return;
        }
        if (kind === "network") {
          setError("Could not reach the network. Try again.");
          return;
        }
      }
      setSnapshot(awaitingCodeSnapshot(emailDisplay.trim(), Date.now()));
    } finally {
      setSubmitting(false);
    }
  }, [client, emailDisplay]);

  const verifyCode = useCallback(async () => {
    if (!client || (snapshot.verifyFailures !== undefined && snapshot.verifyFailures >= OTP_MAX_FAILURES)) {
      setError("Too many attempts. Request a new code.");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setSnapshot((current) => ({ ...current, status: "authenticating" }));
    try {
      const { data, error: verifyError } = await client.auth.verifyOtp({
        email: emailDisplay.trim(),
        token: code.trim(),
        type: "email",
      });
      if (verifyError || !data.session) {
        const kind = mapAuthError(verifyError ?? {});
        const failures = (snapshot.verifyFailures ?? 0) + 1;
        setSnapshot({
          status: "awaiting_code",
          emailDisplay: emailDisplay.trim(),
          verifyFailures: failures,
          resendAvailableAt: snapshot.resendAvailableAt,
        });
        if (failures >= OTP_MAX_FAILURES || kind === "attempts") {
          setError("Too many attempts. Request a new code.");
        } else if (kind === "expired") {
          setError("That code has expired. Request a new one.");
        } else if (kind === "network") {
          setError("Could not reach the network. Try again.");
        } else {
          setError("That code didn't work. Try again.");
        }
        return;
      }
      setCode("");
      try {
        await loadMe(data.session, emailDisplay.trim());
      } catch {
        setSnapshot({
          status: "bootstrap_error",
          emailDisplay: emailDisplay.trim(),
        });
        setError(copy.bootstrapUnavailable);
      }
    } finally {
      setSubmitting(false);
    }
  }, [client, code, emailDisplay, loadMe, snapshot.resendAvailableAt, snapshot.verifyFailures]);

  const changeEmail = useCallback(() => {
    setCode("");
    setError(undefined);
    setSnapshot({ status: "signed_out" });
  }, []);

  const signOut = useCallback(
    async (mode: "confirm" | "discard") => {
      if (mode === "discard") {
        await discardLocalDrafts();
      }
      if (client) {
        await client.auth.signOut();
      }
      await clearAuthMaterial(secureKv);
      setBootstrap(undefined);
      setCode("");
      setEmailDisplay("");
      setError(undefined);
      setSnapshot({ status: "signed_out" });
    },
    [client],
  );

  const refreshBootstrap = useCallback(async () => {
    if (!client) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setSnapshot((current) => ({ ...current, status: "authenticating", emailDisplay: current.emailDisplay }));
    try {
      const existing = await client.auth.getSession();
      if (!existing.data.session) {
        setSnapshot((current) => ({
          status: "bootstrap_error",
          emailDisplay: current.emailDisplay,
        }));
        setError(copy.bootstrapSession);
        return;
      }
      await loadMe(existing.data.session, existing.data.session.user.email);
    } catch {
      setSnapshot((current) => ({
        status: "bootstrap_error",
        emailDisplay: current.emailDisplay,
      }));
      setError(copy.bootstrapUnavailable);
    } finally {
      setSubmitting(false);
    }
  }, [client, loadMe]);

  const runOwnerRequest = useCallback(
    async <T,>(options: OwnerRequestOptions) => {
      const unavailable = {
        ok: false as const,
        error: {
          status: 0,
          code: "UNAVAILABLE",
          message: "Could not reach the network. Try again.",
          retryable: true,
        },
      };
      if (!client) {
        return unavailable;
      }
      const existing = await client.auth.getSession();
      const accessToken = existing.data.session?.access_token;
      if (!accessToken) {
        return {
          ok: false as const,
          error: { status: 401, code: "AUTHENTICATION_REQUIRED", message: "Sign in required.", retryable: false },
        };
      }
      const first = await ownerRequest<T>({
        ...options,
        apiBaseUrl: config.apiBaseUrl,
        accessToken,
      });
      if (first.ok || first.error.status !== 401) {
        return first;
      }
      const refreshed = await client.auth.refreshSession();
      const next = refreshed.data.session?.access_token;
      if (!next) {
        return first;
      }
      return ownerRequest<T>({
        ...options,
        apiBaseUrl: config.apiBaseUrl,
        accessToken: next,
      });
    },
    [client, config.apiBaseUrl],
  );

  const value: AuthContextValue = {
    snapshot,
    bootstrap,
    emailDisplay,
    code,
    setEmailDisplay,
    setCode,
    error,
    submitting,
    resendSeconds: remainingResendSeconds(now, snapshot.resendAvailableAt),
    configured,
    sendCode,
    verifyCode,
    changeEmail,
    signOut,
    draftStatus: getDraftSyncStatus,
    refreshBootstrap,
    runOwnerRequest,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth requires AuthProvider");
  }
  return value;
}
