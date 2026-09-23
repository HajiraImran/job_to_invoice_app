import { OTP_MAX_FAILURES, remainingResendSeconds, type AuthSnapshot } from "@job-to-invoice/schemas";
import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { ownerRequest, type OwnerBootstrap, type OwnerRequestOptions } from "../api/client.ts";
import { publicConfig } from "../config.ts";
import {
  bindDraftSyncController,
  discardLocalDrafts,
  getDraftSyncStatus,
  synchronizeLocalDrafts,
} from "../drafts/sync.ts";
import { completeOwnerSignOut } from "./sign-out.ts";
import { mapAuthError } from "../auth/errors.ts";
import { copy } from "../i18n/en.ts";
import {
  bootstrapErrorCopy,
  classifyOwnerMeError,
  fetchOwnerMe,
  fetchOwnerMeWithOneRefresh,
  type OwnerMeResponse,
} from "./bootstrap.ts";
import { awaitingCodeSnapshot } from "./logic.ts";
import {
  ownerSignInOtpOptions,
  ownerVerifyOtpParams,
  verifiedSessionIsFreshInstall,
} from "./step-up.ts";
import {
  createBootstrapGenerationGate,
  decideBootstrapApply,
  outboxDrainEligibleAfterRecovery,
} from "./recovery.ts";
import { createOwnerAuthClient, secureKv } from "./supabase.ts";
import {
  clearPendingReplace,
  emitReplaceResumeDiagnostic,
  loadPendingReplace,
  reconcilePendingReplace,
  savePendingReplace,
  type PendingReplaceIntent,
} from "../quotes/pending-replace.ts";
import { BOOTSTRAP_KEY, LAST_AUTH_KEY, clearAuthMaterial } from "./storage.ts";
import { createOwnerSyncController, type OwnerSyncController } from "../sync/controller.ts";
import { createExpoSqliteBridge, defaultEncryptedStorageCapability } from "../storage/index.ts";
import { isStorageError } from "../storage/storage-error.ts";

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
  signOut: (mode: "confirm" | "discard" | "synchronize") => Promise<void>;
  draftStatus: () => ReturnType<typeof getDraftSyncStatus>;
  synchronizeNow: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  refreshBootstrap: () => Promise<void>;
  runOwnerRequest: <T>(options: OwnerRequestOptions) => ReturnType<typeof ownerRequest<T>>;
  getSyncSessionDb: () => ReturnType<OwnerSyncController["getSession"]>;
  pendingReplace?: PendingReplaceIntent;
  rememberPendingReplace: (intent: PendingReplaceIntent) => Promise<void>;
  forgetPendingReplace: () => Promise<void>;
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
  const [pendingReplace, setPendingReplace] = useState<PendingReplaceIntent | undefined>();
  const pendingReplaceRef = useRef<PendingReplaceIntent | undefined>(undefined);
  const sessionTokenRef = useRef<string | undefined>(undefined);
  const syncControllerRef = useRef<OwnerSyncController | null>(null);
  const bridgePromiseRef = useRef<ReturnType<typeof createExpoSqliteBridge> | null>(null);
  const bootstrapGateRef = useRef(createBootstrapGenerationGate());
  const bootstrapInFlightRef = useRef<Promise<void> | null>(null);
  const snapshotRef = useRef<AuthSnapshot>(snapshot);
  snapshotRef.current = snapshot;

  const ensureSyncController = useCallback(async () => {
    const capability = defaultEncryptedStorageCapability();
    if (!capability.supported) {
      bindDraftSyncController(null);
      syncControllerRef.current = null;
      return null;
    }
    if (!syncControllerRef.current) {
      bridgePromiseRef.current ??= createExpoSqliteBridge();
      const bridge = await bridgePromiseRef.current;
      syncControllerRef.current = createOwnerSyncController({
        storage: secureKv,
        bridge,
        capability,
      });
      bindDraftSyncController(syncControllerRef.current);
    }
    return syncControllerRef.current;
  }, []);

  const openSyncForBootstrap = useCallback(
    async (next: OwnerBootstrap) => {
      try {
        const controller = await ensureSyncController();
        if (!controller) {
          return;
        }
        if (controller.ownerId && controller.ownerId !== next.user.id) {
          // Account switch with an open session from another owner is refused until wipe.
          await controller.close();
        }
        await controller.ensureOpen(next.user.id, next.workspace.id);
      } catch (error) {
        if (isStorageError(error) && error.code === "OWNER_MISMATCH") {
          setError(copy.discardFailed);
        }
        /* Unsupported runtime or open failure leaves online mode without local sync. */
      }
    },
    [ensureSyncController],
  );

  const drainEligibleOutbox = useCallback(async () => {
    if (!client) {
      return;
    }
    const controller = syncControllerRef.current;
    if (!controller?.getSession()) {
      return;
    }
    const existing = await client.auth.getSession();
    const accessToken = existing.data.session?.access_token;
    if (!accessToken) {
      return;
    }
    await synchronizeLocalDrafts(
      async (options) =>
        ownerRequest({
          ...options,
          apiBaseUrl: config.apiBaseUrl,
          accessToken,
        }),
      { forceImmediate: false },
    );
  }, [client, config.apiBaseUrl]);

  const applyMeResult = useCallback(
    async (result: OwnerMeResponse, emailHint?: string, generation?: number) => {
      const gate = bootstrapGateRef.current;
      const gen = generation ?? gate.begin();
      const authenticatedAt = new Date().toISOString();
      const last = (await secureKv.getItem(LAST_AUTH_KEY)) ?? undefined;
      const cachedRaw = await secureKv.getItem(BOOTSTRAP_KEY);
      let cachedBootstrap: OwnerBootstrap | null = null;
      if (cachedRaw) {
        try {
          cachedBootstrap = JSON.parse(cachedRaw) as OwnerBootstrap;
        } catch {
          cachedBootstrap = null;
        }
      }

      if (result.ok) {
        const decision = decideBootstrapApply({
          generation: gen,
          gate,
          result,
          authenticatedAt,
          emailHint,
          lastAuthenticatedAt: last,
          cachedBootstrap,
          nowMs: Date.now(),
          supportCode: "BOOTSTRAP_UNKNOWN",
        });
        if (decision.action !== "apply_success") {
          return;
        }
        // Persist first, then re-check generation so an older failure cannot win after awaits.
        await secureKv.setItem(BOOTSTRAP_KEY, JSON.stringify(decision.bootstrap));
        await secureKv.setItem(LAST_AUTH_KEY, decision.authenticatedAt);
        if (!gate.canApplySuccess(gen)) {
          return;
        }
        const stored = await loadPendingReplace(secureKv, Date.now(), decision.bootstrap.user.id);
        if (!gate.canApplySuccess(gen)) {
          return;
        }
        const nextPending = reconcilePendingReplace({ stored, memory: pendingReplaceRef.current });
        pendingReplaceRef.current = nextPending;
        gate.markApplied(gen);
        setPendingReplace(nextPending);
        setBootstrap(decision.bootstrap);
        setSnapshot(decision.snapshot);
        snapshotRef.current = decision.snapshot;
        setError(undefined);
        await openSyncForBootstrap(decision.bootstrap);
        if (
          decision.enableOutboxDrain &&
          decision.bootstrap.user.status !== "deleting" &&
          outboxDrainEligibleAfterRecovery(decision.snapshot.status)
        ) {
          await drainEligibleOutbox();
        }
        return;
      }

      const supportCode = classifyOwnerMeError(result.error);
      const decision = decideBootstrapApply({
        generation: gen,
        gate,
        result,
        authenticatedAt,
        emailHint,
        lastAuthenticatedAt: last,
        cachedBootstrap,
        nowMs: Date.now(),
        supportCode,
      });
      if (decision.action === "ignore_stale") {
        return;
      }
      if (decision.action !== "apply_failure") {
        return;
      }
      if (!gate.canApplyFailure(gen)) {
        return;
      }
      gate.markApplied(gen);
      if (decision.bootstrap) {
        setBootstrap(decision.bootstrap);
        setSnapshot(decision.snapshot);
        snapshotRef.current = decision.snapshot;
        await openSyncForBootstrap(decision.bootstrap);
        return;
      }
      setSnapshot(decision.snapshot);
      snapshotRef.current = decision.snapshot;
      if (decision.snapshot.status !== "access_expired") {
        setError(copy[bootstrapErrorCopy(supportCode)]);
      }
    },
    [drainEligibleOutbox, openSyncForBootstrap],
  );

  const requestMe = useCallback(
    (accessToken: string) =>
      fetchOwnerMe({
        apiBaseUrl: config.apiBaseUrl,
        accessToken,
      }),
    [config.apiBaseUrl],
  );

  const loadMe = useCallback(
    async (session: Session, emailHint?: string) => {
      sessionTokenRef.current = session.access_token;
      const run = (async () => {
        const generation = bootstrapGateRef.current.begin();
        const result = await fetchOwnerMeWithOneRefresh({
          accessToken: session.access_token,
          fetchMe: requestMe,
          refresh: async () => {
            if (!client) {
              return undefined;
            }
            const refreshed = await client.auth.refreshSession();
            const next = refreshed.data.session?.access_token;
            if (next) {
              sessionTokenRef.current = next;
            }
            return next;
          },
        });
        await applyMeResult(result, emailHint, generation);
      })();
      const tracked = run.finally(() => {
        bootstrapInFlightRef.current = null;
      });
      bootstrapInFlightRef.current = tracked;
      await tracked;
    },
    [applyMeResult, client, requestMe],
  );

  const recoverBootstrapIfNeeded = useCallback(async () => {
    if (!client) {
      return;
    }
    const status = snapshotRef.current.status;
    // Re-authorize when stale offline, or refresh online session on foreground.
    if (status !== "offline_cached" && status !== "authenticated") {
      return;
    }
    const existing = await client.auth.getSession();
    if (!existing.data.session) {
      return;
    }
    await loadMe(existing.data.session, existing.data.session.user.email);
  }, [client, loadMe]);

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
              supportCode: "BOOTSTRAP_UNKNOWN",
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
        void recoverBootstrapIfNeeded();
      }
    });
    return () => sub.remove();
  }, [recoverBootstrapIfNeeded]);

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
        options: ownerSignInOtpOptions(),
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
      if (pendingReplaceRef.current) {
        emitReplaceResumeDiagnostic({ stage: "step_up_started", outcome: "otp_sent" });
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
      const previousAccessToken = sessionTokenRef.current;
      const { data, error: verifyError } = await client.auth.verifyOtp(
        ownerVerifyOtpParams(emailDisplay, code),
      );
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
      const verifiedAccessToken = data.session.access_token;
      const install = verifiedSessionIsFreshInstall({
        previousAccessToken,
        verifiedAccessToken,
      });
      if (pendingReplaceRef.current) {
        emitReplaceResumeDiagnostic({ stage: "step_up_verified", outcome: "ok" });
        emitReplaceResumeDiagnostic({
          stage: "fresh_session_ready",
          outcome: install.ok ? "ok" : install.outcome,
        });
      }
      sessionTokenRef.current = verifiedAccessToken;
      try {
        await client.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
      } catch {
        // verifyOtp already persisted the session; continue with the verified token.
      }
      try {
        await loadMe(data.session, emailDisplay.trim());
      } catch {
        setSnapshot({
          status: "bootstrap_error",
          emailDisplay: emailDisplay.trim(),
          supportCode: "BOOTSTRAP_UNKNOWN",
        });
        setError(copy.bootstrapUnavailable);
      }
    } finally {
      setSubmitting(false);
    }
  }, [client, code, emailDisplay, loadMe, snapshot.resendAvailableAt, snapshot.verifyFailures]);

  const rememberPendingReplace = useCallback(async (intent: PendingReplaceIntent) => {
    pendingReplaceRef.current = intent;
    await savePendingReplace(secureKv, intent);
    setPendingReplace(intent);
  }, []);

  const forgetPendingReplace = useCallback(async () => {
    pendingReplaceRef.current = undefined;
    await clearPendingReplace(secureKv);
    setPendingReplace(undefined);
  }, []);

  const changeEmail = useCallback(() => {
    setCode("");
    setError(undefined);
    setSnapshot({ status: "signed_out" });
    void forgetPendingReplace();
  }, [forgetPendingReplace]);

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
      const accessToken = sessionTokenRef.current ?? existing.data.session?.access_token;
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
      sessionTokenRef.current = next;
      return ownerRequest<T>({
        ...options,
        apiBaseUrl: config.apiBaseUrl,
        accessToken: next,
      });
    },
    [client, config.apiBaseUrl],
  );

  const signOut = useCallback(
    async (mode: "confirm" | "discard" | "synchronize") => {
      setError(undefined);
      const result = await completeOwnerSignOut({
        mode,
        discardDrafts: discardLocalDrafts,
        synchronizeDrafts: async () => {
          const synced = await synchronizeLocalDrafts(
            async (options) => {
              if (!client) {
                return {
                  ok: false as const,
                  error: {
                    status: 0,
                    code: "UNAVAILABLE",
                    message: "Could not reach the network. Try again.",
                    retryable: true,
                  },
                };
              }
              return runOwnerRequest(options);
            },
            { forceImmediate: true },
          );
          return synced.ok ? { ok: true as const } : { ok: false as const };
        },
        providerSignOut: async () => {
          if (client) {
            await client.auth.signOut();
          }
        },
        clearStoredAuth: () => clearAuthMaterial(secureKv),
        clearMemory: () => {
          bindDraftSyncController(null);
          syncControllerRef.current = null;
          sessionTokenRef.current = undefined;
          pendingReplaceRef.current = undefined;
          setBootstrap(undefined);
          setPendingReplace(undefined);
          setCode("");
          setEmailDisplay("");
          setError(undefined);
          setSnapshot({ status: "signed_out" });
        },
      });
      if (!result.ok) {
        if (result.stage === "discard") {
          setError(copy.discardFailed);
        } else if (result.stage === "synchronize") {
          setError(copy.synchronizeFailed);
        } else {
          setError(copy.signOutFailed);
        }
      }
    },
    [client, runOwnerRequest],
  );

  const synchronizeNow = useCallback(async () => {
    const synced = await synchronizeLocalDrafts(async (options) => runOwnerRequest(options), {
      forceImmediate: true,
    });
    if (!synced.ok) {
      setError(synced.reason === "conflict" ? copy.synchronizeConflict : copy.synchronizeFailed);
    }
    return synced;
  }, [runOwnerRequest]);

  const refreshBootstrap = useCallback(async () => {
    if (!client) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setSnapshot((current) => {
      const next = { ...current, status: "authenticating" as const, emailDisplay: current.emailDisplay };
      snapshotRef.current = next;
      return next;
    });
    try {
      const existing = await client.auth.getSession();
      if (!existing.data.session) {
        setSnapshot((current) => ({
          status: "bootstrap_error",
          emailDisplay: current.emailDisplay,
          supportCode: "BOOTSTRAP_SESSION",
        }));
        setError(copy.bootstrapSession);
        return;
      }
      await loadMe(existing.data.session, existing.data.session.user.email);
    } catch {
      setSnapshot((current) => ({
        status: "bootstrap_error",
        emailDisplay: current.emailDisplay,
        supportCode: "BOOTSTRAP_UNKNOWN",
      }));
      setError(copy.bootstrapUnavailable);
    } finally {
      setSubmitting(false);
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
    synchronizeNow,
    refreshBootstrap,
    runOwnerRequest,
    getSyncSessionDb: () => syncControllerRef.current?.getSession() ?? null,
    pendingReplace,
    rememberPendingReplace,
    forgetPendingReplace,
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
