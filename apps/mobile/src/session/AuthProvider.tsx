import { OTP_MAX_FAILURES, remainingResendSeconds, type AuthSnapshot } from "@job-to-invoice/schemas";
import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { ownerRequest, type OwnerBootstrap } from "../api/client.ts";
import { publicConfig } from "../config.ts";
import { discardLocalDrafts, getDraftSyncStatus } from "../drafts/sync.ts";
import { mapAuthError } from "../auth/errors.ts";
import {
  awaitingCodeSnapshot,
  snapshotAfterRefreshFailure,
  snapshotFromBootstrap,
} from "./logic.ts";
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
  }, []);

  const loadMe = useCallback(
    async (session: Session, allowRefresh: boolean) => {
      const first = await ownerRequest<OwnerBootstrap>({
        apiBaseUrl: config.apiBaseUrl,
        path: "/v1/me",
        accessToken: session.access_token,
      });
      if (first.ok) {
        await persistBootstrap(first.data, new Date().toISOString());
        return;
      }
      if (first.error.status === 401 && allowRefresh && client) {
        const refreshed = await client.auth.refreshSession();
        const next = refreshed.data.session;
        if (next) {
          const retry = await ownerRequest<OwnerBootstrap>({
            apiBaseUrl: config.apiBaseUrl,
            path: "/v1/me",
            accessToken: next.access_token,
          });
          if (retry.ok) {
            await persistBootstrap(retry.data, new Date().toISOString());
            return;
          }
        }
      }
      const last = (await secureKv.getItem(LAST_AUTH_KEY)) ?? undefined;
      const cached = await secureKv.getItem(BOOTSTRAP_KEY);
      const nextSnap = snapshotAfterRefreshFailure(last, Date.now());
      if (nextSnap.status === "offline_cached" && cached) {
        setBootstrap(JSON.parse(cached) as OwnerBootstrap);
        setSnapshot({
          ...nextSnap,
          setupCompleted: (JSON.parse(cached) as OwnerBootstrap).workspace.setup_completed,
          emailDisplay: (JSON.parse(cached) as OwnerBootstrap).user.display_email,
        });
        return;
      }
      setSnapshot({ status: nextSnap.status === "access_expired" ? "access_expired" : "signed_out" });
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
        await loadMe(existing.data.session, true);
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
      await loadMe(data.session, false);
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
    const existing = await client.auth.getSession();
    if (existing.data.session) {
      await loadMe(existing.data.session, true);
    }
  }, [client, loadMe]);

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
