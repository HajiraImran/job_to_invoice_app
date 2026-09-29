import {
  OTP_MAX_FAILURES,
  parseOwnerEmail,
  remainingResendSeconds,
  resendAvailableAt,
  type AuthSnapshot,
} from "@job-to-invoice/schemas";
import { isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import {
  createClientRequestId,
  ownerRequest,
  type ApiError,
  type OwnerBootstrap,
  type OwnerRequestOptions,
} from "../api/client.ts";
import {
  authHealthUrl,
  createReachabilityCheck,
  probeInternet,
  refineNetworkFailure,
  requestFailureMessage,
} from "../api/reachability.ts";
import { publicConfig } from "../config.ts";
import {
  bindDraftSyncController,
  discardLocalDrafts,
  getDraftSyncStatus,
  synchronizeLocalDrafts,
} from "../drafts/sync.ts";
import { completeOwnerSignOut, signOutFailureCopy } from "./sign-out.ts";
import { mapAuthError, otpErrorCopy } from "../auth/errors.ts";
import { copy } from "../i18n/en.ts";
import {
  backgroundBootstrapRetryDelay,
  bootstrapErrorCopy,
  classifyOwnerMeError,
  fetchOwnerMe,
  fetchOwnerMeWithOneRefresh,
  fetchOwnerMeWithTransientRetry,
  sessionReadOutcome,
  shouldAutoRetryBootstrap,
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
  sendCode: () => Promise<{ ok: true } | { ok: false }>;
  sendFreshGrantCode: () => Promise<{ ok: true } | { ok: false }>;
  verifyCode: () => Promise<void>;
  verifyFreshGrantCode: () => Promise<boolean>;
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
  const backgroundRetryAttemptRef = useRef(0);
  const checkReachability = useMemo(
    () => createReachabilityCheck(() => probeInternet({ url: authHealthUrl(config.authProjectUrl) })),
    [config.authProjectUrl],
  );

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
    async (accessToken: string) => {
      const clientRequestId = createClientRequestId();
      const startedAt = Date.now();
      const result = await fetchOwnerMe({
        apiBaseUrl: config.apiBaseUrl,
        accessToken,
        clientRequestId,
      });
      if (__DEV__) {
        console.info(
          JSON.stringify({
            event: "owner_me_client",
            status: result.ok ? 200 : result.error.status,
            ...(result.ok ? {} : { code: result.error.code, network: result.error.network }),
            ms: Date.now() - startedAt,
            client_request_id: clientRequestId,
            ...(!result.ok && result.error.requestId ? { request_id: result.error.requestId } : {}),
          }),
        );
      }
      return result;
    },
    [config.apiBaseUrl],
  );

  const loadMe = useCallback(
    async (session: Session, emailHint?: string) => {
      sessionTokenRef.current = session.access_token;
      const run = (async () => {
        const generation = bootstrapGateRef.current.begin();
        const retried = await fetchOwnerMeWithTransientRetry({
          attempt: () =>
            fetchOwnerMeWithOneRefresh({
              accessToken: sessionTokenRef.current ?? session.access_token,
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
            }),
          shouldContinue: () => bootstrapGateRef.current.canApplyFailure(generation),
        });
        const result: OwnerMeResponse = retried.ok
          ? retried
          : { ok: false, error: await refineNetworkFailure(retried.error, checkReachability) };
        await applyMeResult(result, emailHint, generation);
      })();
      const tracked = run.finally(() => {
        bootstrapInFlightRef.current = null;
      });
      bootstrapInFlightRef.current = tracked;
      await tracked;
    },
    [applyMeResult, checkReachability, client, requestMe],
  );

  /** A session-read failure caused by the network must not look like a sign-out. */
  const applySessionReadNetworkFailure = useCallback(async () => {
    const generation = bootstrapGateRef.current.begin();
    const error = await refineNetworkFailure(
      {
        status: 0,
        code: "UNAVAILABLE",
        message: copy.networkError,
        retryable: true,
        network: "unreachable",
      } satisfies ApiError,
      checkReachability,
    );
    await applyMeResult({ ok: false, error }, snapshotRef.current.emailDisplay, generation);
  }, [applyMeResult, checkReachability]);

  const recoverBootstrapIfNeeded = useCallback(async () => {
    if (!client || bootstrapInFlightRef.current) {
      return;
    }
    const current = snapshotRef.current;
    // Re-authorize when stale offline, refresh online session, or retry a transient bootstrap failure.
    if (
      current.status !== "offline_cached" &&
      current.status !== "authenticated" &&
      !shouldAutoRetryBootstrap(current)
    ) {
      return;
    }
    const existing = await client.auth.getSession();
    if (!existing.data.session) {
      const outcome = sessionReadOutcome({
        hasSession: false,
        error: existing.error,
        isRetryableFetchError: isAuthRetryableFetchError,
      });
      if (outcome === "network_failure" && current.status !== "authenticated") {
        await applySessionReadNetworkFailure();
      }
      return;
    }
    await loadMe(existing.data.session, existing.data.session.user.email);
  }, [applySessionReadNetworkFailure, client, loadMe]);

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
      } else if (
        sessionReadOutcome({
          hasSession: false,
          error: existing.error,
          isRetryableFetchError: isAuthRetryableFetchError,
        }) === "network_failure"
      ) {
        await applySessionReadNetworkFailure();
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
  }, [applySessionReadNetworkFailure, client, loadMe]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setNow(Date.now());
        backgroundRetryAttemptRef.current = 0;
        void recoverBootstrapIfNeeded();
      }
    });
    return () => sub.remove();
  }, [recoverBootstrapIfNeeded]);

  useEffect(() => {
    if (snapshot.status === "authenticated") {
      backgroundRetryAttemptRef.current = 0;
      return undefined;
    }
    if (!shouldAutoRetryBootstrap(snapshot)) {
      return undefined;
    }
    const delay = backgroundBootstrapRetryDelay(backgroundRetryAttemptRef.current);
    const timer = setTimeout(() => {
      if (AppState.currentState !== "active") {
        return;
      }
      backgroundRetryAttemptRef.current += 1;
      void recoverBootstrapIfNeeded();
    }, delay);
    return () => clearTimeout(timer);
    // A failed retry applies a new snapshot object, which schedules the next attempt.
  }, [recoverBootstrapIfNeeded, snapshot]);

  useEffect(() => {
    if (snapshot.status !== "awaiting_code" && snapshot.resendAvailableAt === undefined) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.resendAvailableAt, snapshot.status]);

  const sendCode = useCallback(async (): Promise<{ ok: true } | { ok: false }> => {
    setError(undefined);
    const parsed = parseOwnerEmail(emailDisplay);
    if (!parsed.ok) {
      setError(parsed.code === "too_long" ? copy.emailTooLong : copy.invalidEmail);
      return { ok: false };
    }
    if (!client) {
      setError("Authentication is not configured on this build.");
      return { ok: false };
    }
    setSubmitting(true);
    try {
      const { error: sendError } = await client.auth.signInWithOtp({
        email: parsed.display,
        options: ownerSignInOtpOptions(),
      });
      if (sendError) {
        const kind = mapAuthError(sendError);
        if (kind === "throttled" || kind === "network") {
          setError(otpErrorCopy(kind));
          return { ok: false };
        }
      }
      if (pendingReplaceRef.current) {
        emitReplaceResumeDiagnostic({ stage: "step_up_started", outcome: "otp_sent" });
      }
      setSnapshot(awaitingCodeSnapshot(parsed.display, Date.now()));
      return { ok: true };
    } finally {
      setSubmitting(false);
    }
  }, [client, emailDisplay]);

  const sendFreshGrantCode = useCallback(async (): Promise<{ ok: true } | { ok: false }> => {
    setError(undefined);
    const parsed = parseOwnerEmail(emailDisplay);
    if (!parsed.ok) {
      setError(parsed.code === "too_long" ? copy.emailTooLong : copy.invalidEmail);
      return { ok: false };
    }
    if (!client) {
      setError("Authentication is not configured on this build.");
      return { ok: false };
    }
    setSubmitting(true);
    try {
      const { error: sendError } = await client.auth.signInWithOtp({
        email: parsed.display,
        options: ownerSignInOtpOptions(),
      });
      if (sendError) {
        const kind = mapAuthError(sendError);
        if (kind === "throttled" || kind === "network") {
          setError(otpErrorCopy(kind));
          return { ok: false };
        }
      }
      setSnapshot((current) => ({
        ...current,
        emailDisplay: current.emailDisplay ?? parsed.display,
        resendAvailableAt: resendAvailableAt(Date.now()),
        verifyFailures: 0,
      }));
      return { ok: true };
    } finally {
      setSubmitting(false);
    }
  }, [client, emailDisplay]);

  const verifyCode = useCallback(async () => {
    if (!client || (snapshot.verifyFailures !== undefined && snapshot.verifyFailures >= OTP_MAX_FAILURES)) {
      setError(otpErrorCopy("attempts"));
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
          setError(otpErrorCopy("attempts"));
        } else if (kind === "expired") {
          setError(otpErrorCopy("expired"));
        } else if (kind === "network") {
          setError(otpErrorCopy("network"));
        } else {
          setError(otpErrorCopy("incorrect"));
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

  const verifyFreshGrantCode = useCallback(async (): Promise<boolean> => {
    if (!client || (snapshot.verifyFailures !== undefined && snapshot.verifyFailures >= OTP_MAX_FAILURES)) {
      setError(otpErrorCopy("attempts"));
      return false;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const { data, error: verifyError } = await client.auth.verifyOtp(ownerVerifyOtpParams(emailDisplay, code));
      if (verifyError || !data.session) {
        const kind = mapAuthError(verifyError ?? {});
        const failures = (snapshot.verifyFailures ?? 0) + 1;
        setSnapshot((current) => ({ ...current, verifyFailures: failures }));
        if (failures >= OTP_MAX_FAILURES || kind === "attempts") {
          setError(otpErrorCopy("attempts"));
        } else if (kind === "expired") {
          setError(otpErrorCopy("expired"));
        } else if (kind === "network") {
          setError(otpErrorCopy("network"));
        } else {
          setError(otpErrorCopy("incorrect"));
        }
        return false;
      }
      setCode("");
      sessionTokenRef.current = data.session.access_token;
      try {
        await client.auth.setSession({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        });
      } catch {
        // verifyOtp already persisted the session.
      }
      try {
        await loadMe(data.session, emailDisplay.trim());
      } catch {
        setError(copy.bootstrapUnavailable);
        return false;
      }
      return true;
    } finally {
      setSubmitting(false);
    }
  }, [client, code, emailDisplay, loadMe, snapshot.verifyFailures]);

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
      // getSession returns the auto-refreshed token; the ref alone can hold an expired one.
      const accessToken = existing.data.session?.access_token ?? sessionTokenRef.current;
      if (existing.data.session?.access_token) {
        sessionTokenRef.current = existing.data.session.access_token;
      }
      if (!accessToken) {
        return {
          ok: false as const,
          error: { status: 401, code: "AUTHENTICATION_REQUIRED", message: "Sign in required.", retryable: false },
        };
      }
      const explain = async <R extends { ok: true; data: T } | { ok: false; error: ApiError }>(result: R) => {
        if (result.ok) {
          return result;
        }
        const refined = await refineNetworkFailure(result.error, checkReachability);
        const message =
          refined.status === 0 || refined.code === "DATABASE_TIMEOUT" || refined.code === "DATABASE_UNAVAILABLE"
            ? requestFailureMessage(refined)
            : refined.message;
        return { ok: false as const, error: { ...refined, message } };
      };
      const first = await ownerRequest<T>({
        ...options,
        apiBaseUrl: config.apiBaseUrl,
        accessToken,
      });
      if (first.ok || first.error.status !== 401) {
        return explain(first);
      }
      const refreshed = await client.auth.refreshSession();
      const next = refreshed.data.session?.access_token;
      if (!next) {
        return first;
      }
      sessionTokenRef.current = next;
      return explain(
        await ownerRequest<T>({
          ...options,
          apiBaseUrl: config.apiBaseUrl,
          accessToken: next,
        }),
      );
    },
    [checkReachability, client, config.apiBaseUrl],
  );

  const signOut = useCallback(
    async (mode: "confirm" | "discard" | "synchronize") => {
      setError(undefined);
      let synchronizeReason: "conflict" | "failed" | "storage" | undefined;
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
          if (!synced.ok) {
            synchronizeReason = synced.reason;
            return { ok: false as const };
          }
          return { ok: true as const };
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
        setError(signOutFailureCopy(result.stage, synchronizeReason));
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

  const getSyncSessionDb = useCallback(() => syncControllerRef.current?.getSession() ?? null, []);
  const resendSeconds = remainingResendSeconds(now, snapshot.resendAvailableAt);

  const value = useMemo<AuthContextValue>(
    () => ({
      snapshot,
      bootstrap,
      emailDisplay,
      code,
      setEmailDisplay,
      setCode,
      error,
      submitting,
      resendSeconds,
      configured,
      sendCode,
      sendFreshGrantCode,
      verifyCode,
      verifyFreshGrantCode,
      changeEmail,
      signOut,
      draftStatus: getDraftSyncStatus,
      synchronizeNow,
      refreshBootstrap,
      runOwnerRequest,
      getSyncSessionDb,
      pendingReplace,
      rememberPendingReplace,
      forgetPendingReplace,
    }),
    [
      snapshot,
      bootstrap,
      emailDisplay,
      code,
      error,
      submitting,
      resendSeconds,
      configured,
      sendCode,
      sendFreshGrantCode,
      verifyCode,
      verifyFreshGrantCode,
      changeEmail,
      signOut,
      synchronizeNow,
      refreshBootstrap,
      runOwnerRequest,
      getSyncSessionDb,
      pendingReplace,
      rememberPendingReplace,
      forgetPendingReplace,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth requires AuthProvider");
  }
  return value;
}
