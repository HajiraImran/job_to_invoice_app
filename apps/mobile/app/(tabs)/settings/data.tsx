import { useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { presentResendLabel, presentVerifyReady } from "../../../src/auth/presentation.ts";
import { VerifyCodeField } from "../../../src/auth/VerifyCodeField.tsx";
import { secureRandomUUID } from "../../../src/crypto/uuid.ts";
import {
  deletionBadge,
  deletionConfirmEnabled,
  deletionIdempotencyAfterFailure,
  deletionStatusLabel,
  presentDeletion,
  visibleRetentionCategories,
  type DeletionRecord,
} from "../../../src/deletion/presentation.ts";
import { issueDeletionGrant, submitDeletionRequest } from "../../../src/deletion/request-deletion.ts";
import { issueExportGrant, submitExportRequest } from "../../../src/export/request-export.ts";
import {
  APPLE_SUBSCRIPTIONS_URL,
  exportIdempotencyAfterFailure,
  exportPollShouldStop,
  exportStatusLabel,
  nextExportRecord,
  presentExport,
  presentPrivacySurface,
  privacyCommandBlocked,
  type ExportRecord,
} from "../../../src/export/presentation.ts";
import { copy } from "../../../src/i18n/en.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors } from "../../../src/theme.ts";

const PRIMARY = "#464B71";
const TITLE = "#1F2430";
const MUTED = "#636B7D";
const LINE = "#E2E5EC";
const DANGER = "#BA333B";
const DANGER_BG = "#FFECED";
const READY = "#1F8C61";
const READY_BG = "#E5FAF0";
const INFO_BG = "#EDF4FF";
const INFO_LINE = "#D1E5FF";
const WARN_BG = "#FFF6E3";
const WARN_LINE = "#F2CC80";
const DISABLED_BG = "#F2F4F6";
const DISABLED_LINE = "#D1D4DE";
const DISABLED = "#8C91A1";

type PendingAction = "export" | "export_newer" | "deletion";

export default function ExportDataScreen() {
  const auth = useAuth();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const runOwnerRequest = auth.runOwnerRequest;
  const [record, setRecord] = useState<ExportRecord | null>(null);
  const [deletion, setDeletion] = useState<DeletionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [deletionError, setDeletionError] = useState<string | undefined>();
  const [confirmation, setConfirmation] = useState("");
  const exportKey = useRef(retainOrCreateSetupIdempotencyKey(undefined));
  const newerKey = useRef<string | undefined>(undefined);
  const deletionKey = useRef(retainOrCreateSetupIdempotencyKey(undefined));
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const busy = useRef(false);
  const exportRef = useRef<View>(null);
  const errorRef = useRef<Text>(null);

  function setPendingAction(value: PendingAction | null) {
    pendingRef.current = value;
    setPending(value);
  }

  const leave = useCallback(() => {
    if (auth.snapshot.status === "access_expired") {
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(tabs)/settings");
  }, [auth.snapshot.status, router]);

  useEffect(() => {
    const targets: Array<{ setOptions: (options: { tabBarStyle?: { display: "none" } }) => void }> = [];
    let parent = navigation.getParent() as
      | { setOptions: (options: { tabBarStyle?: { display: "none" } }) => void; getParent: () => unknown }
      | undefined;
    while (parent && targets.length < 3) {
      targets.push(parent);
      const next = parent.getParent();
      parent =
        next && typeof next === "object" && "setOptions" in next && "getParent" in next
          ? (next as typeof parent)
          : undefined;
    }
    for (const target of targets) {
      target.setOptions({ tabBarStyle: { display: "none" } });
    }
    return () => {
      for (const target of targets) {
        target.setOptions({ tabBarStyle: undefined });
      }
    };
  }, [navigation]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (pendingRef.current) {
        setPendingAction(null);
        return true;
      }
      leave();
      return true;
    });
    return () => subscription.remove();
  }, [leave]);

  const loadLatest = useCallback(async () => {
    const result = await runOwnerRequest<{ export: ExportRecord | null }>({
      path: "/v1/exports/latest",
      method: "GET",
    });
    setRecord((current) =>
      nextExportRecord(
        current,
        result.ok ? { ok: true, record: result.data.export } : { ok: false },
      ),
    );
    if (result.ok) {
      setError(undefined);
    } else if (result.error.code !== "ACCOUNT_DELETING") {
      setError(result.error.message || copy.exportLoadError);
    }
    const deletionResult = await runOwnerRequest<{ deletion: DeletionRecord | null }>({
      path: "/v1/account/deletion",
      method: "GET",
    });
    if (deletionResult.ok) {
      setDeletion(deletionResult.data.deletion);
      setDeletionError(undefined);
    } else if (deletionResult.error.code !== "ACCOUNT_DELETING") {
      setDeletionError(deletionResult.error.message || copy.deletionLoadError);
    }
    setLoading(false);
  }, [runOwnerRequest]);

  useEffect(() => {
    void loadLatest();
    return () => {
      if (poll.current) {
        clearInterval(poll.current);
      }
    };
  }, [loadLatest]);

  function focusError() {
    requestAnimationFrame(() => {
      const node = findNodeHandle(errorRef.current);
      if (node) {
        AccessibilityInfo.setAccessibilityFocus(node);
      }
    });
  }

  function startPolling(id: string) {
    if (poll.current) {
      clearInterval(poll.current);
    }
    poll.current = setInterval(() => {
      void runOwnerRequest<ExportRecord>({ path: `/v1/exports/${id}`, method: "GET" }).then((result) => {
        if (!result.ok) {
          setError(result.error.message || copy.exportLoadError);
          focusError();
          return;
        }
        setRecord(result.data);
        if (exportPollShouldStop(result.data.status) && poll.current) {
          clearInterval(poll.current);
          setRequesting(false);
        }
      });
    }, 2500);
  }

  async function requestExport(newer = false) {
    if (
      pendingRef.current ||
      privacyCommandBlocked({
        offline: auth.snapshot.status === "offline_cached",
        expired: auth.snapshot.status === "access_expired",
        busy: busy.current,
        locked: Boolean(deletion) || auth.bootstrap?.user.status === "deleting",
      })
    ) {
      return;
    }
    busy.current = true;
    setRequesting(true);
    setError(undefined);
    const grant = await issueExportGrant((options) => runOwnerRequest(options));
    if (!grant.ok && grant.stepUp) {
      setPendingAction(newer ? "export_newer" : "export");
      setRequesting(false);
      busy.current = false;
      const email = auth.emailDisplay || auth.snapshot.emailDisplay || "";
      if (email) {
        auth.setEmailDisplay(email);
      }
      auth.setCode("");
      await auth.sendFreshGrantCode();
      return;
    }
    if (!grant.ok) {
      setRequesting(false);
      busy.current = false;
      setError(grant.error.message || copy.exportStartError);
      focusError();
      return;
    }
    const key = newer
      ? (newerKey.current ?? (newerKey.current = secureRandomUUID()))
      : exportKey.current;
    const submitted = await submitExportRequest((options) => runOwnerRequest(options), {
      grant: grant.grant,
      idempotencyKey: key,
      newer,
    });
    if (!submitted.ok) {
      const rotated = exportIdempotencyAfterFailure(key, submitted.error.code);
      if (newer) {
        newerKey.current = rotated;
      } else if (!rotated) {
        exportKey.current = secureRandomUUID();
      }
      setRequesting(false);
      busy.current = false;
      setError(submitted.error.message || copy.exportStartError);
      focusError();
      return;
    }
    if (newer) {
      newerKey.current = undefined;
    }
    startPolling(submitted.id);
    busy.current = false;
  }

  async function requestDeletion() {
    if (
      pendingRef.current ||
      privacyCommandBlocked({
        offline: auth.snapshot.status === "offline_cached",
        expired: auth.snapshot.status === "access_expired",
        busy: busy.current,
        locked: Boolean(deletion) || auth.bootstrap?.user.status === "deleting",
      }) ||
      !deletionConfirmEnabled(confirmation, deleting)
    ) {
      return;
    }
    busy.current = true;
    setDeleting(true);
    setDeletionError(undefined);
    const grant = await issueDeletionGrant((options) => runOwnerRequest(options));
    if (!grant.ok && grant.stepUp) {
      setPendingAction("deletion");
      setDeleting(false);
      busy.current = false;
      const email = auth.emailDisplay || auth.snapshot.emailDisplay || "";
      if (email) {
        auth.setEmailDisplay(email);
      }
      auth.setCode("");
      await auth.sendFreshGrantCode();
      return;
    }
    if (!grant.ok) {
      setDeleting(false);
      busy.current = false;
      setDeletionError(grant.error.message || copy.deletionStartError);
      focusError();
      return;
    }
    const submitted = await submitDeletionRequest((options) => runOwnerRequest(options), {
      grant: grant.grant,
      idempotencyKey: deletionKey.current,
    });
    if (!submitted.ok) {
      const rotated = deletionIdempotencyAfterFailure(deletionKey.current, submitted.error.code);
      if (!rotated) {
        deletionKey.current = secureRandomUUID();
      }
      setDeleting(false);
      busy.current = false;
      setDeletionError(submitted.error.message || copy.deletionStartError);
      focusError();
      return;
    }
    await loadLatest();
    setConfirming(false);
    setDeleting(false);
    busy.current = false;
  }

  async function verifyPending() {
    if (busy.current || !pendingRef.current) {
      return;
    }
    if (!presentVerifyReady(auth.code, auth.snapshot.verifyFailures ?? 0, auth.submitting)) {
      return;
    }
    busy.current = true;
    const verified = await auth.verifyFreshGrantCode();
    busy.current = false;
    if (!verified) {
      focusError();
      return;
    }
    const action = pendingRef.current;
    setPendingAction(null);
    if (action === "deletion") {
      await requestDeletion();
      return;
    }
    await requestExport(action === "export_newer");
  }

  async function download() {
    if (!record?.id || !record.download_available || busy.current) {
      return;
    }
    const result = await runOwnerRequest<{ url: string }>({
      path: `/v1/exports/${record.id}/download`,
      method: "GET",
    });
    if (!result.ok || !result.data.url) {
      setError(result.ok ? copy.exportDownloadError : result.error.message || copy.exportDownloadError);
      focusError();
      return;
    }
    await Linking.openURL(result.data.url);
  }

  const view = presentExport({
    authStatus: auth.snapshot.status,
    loading,
    requesting,
    stepUp: pending === "export" || pending === "export_newer",
    record,
    error,
  });
  const deletionView = presentDeletion({
    authStatus: auth.snapshot.status,
    accountStatus: auth.bootstrap?.user.status,
    requesting: deleting,
    stepUp: pending === "deletion",
    confirmation,
    record: deletion,
    error: deletionError,
  });
  const surface = presentPrivacySurface({
    authStatus: auth.snapshot.status,
    loading,
    hasExport: Boolean(record),
    exportStatus: record?.status,
    requesting,
    deletionLocked: deletionView.kind === "locked",
    confirmingDeletion: confirming,
  });
  const hint =
    surface === "preparing"
      ? copy.privacyPreparingHint
      : surface === "ready"
        ? copy.privacyReadyHint
        : surface === "confirm_deletion"
          ? copy.privacyDeleteHint
          : surface === "locked"
            ? copy.privacyLockedHint
            : surface === "offline"
              ? copy.privacyOfflineHint
              : surface === "access_expired"
                ? copy.privacyAccessHint
                : copy.privacyHeaderHint;
  const categories = visibleRetentionCategories(deletion?.retained_categories);

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 24) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel={copy.privacyBack}
            accessibilityRole="button"
            onPress={leave}
            style={styles.back}
          >
            <Text style={styles.backGlyph}>{"\u2039"}</Text>
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>{copy.privacyHeader}</Text>
            <Text style={styles.headerHint}>{hint}</Text>
          </View>
        </View>
        {surface === "access_expired" ? (
          <View style={styles.expired}>
            <View style={styles.lockWell}>
              <Text style={styles.lockGlyph}>{"\u25A3"}</Text>
            </View>
            <Text accessibilityRole="header" style={styles.expiredTitle}>
              {copy.conflictSignInTitle}
            </Text>
            <Text accessibilityLiveRegion="polite" style={styles.expiredBody}>
              {copy.accessExpired}
            </Text>
            <View style={styles.privacyCard}>
              <Text style={styles.privacyTitle}>{copy.privacyHiddenTitle}</Text>
              <Text style={styles.privacyBody}>{copy.privacyHiddenBody}</Text>
            </View>
          </View>
        ) : null}
        {surface === "offline" ? (
          <>
            <View accessibilityLiveRegion="polite" style={styles.offline}>
              <Text style={styles.offlineTitle}>{copy.privacyOfflineTitle}</Text>
              <Text style={styles.offlineBody}>{copy.privacyOfflineBody}</Text>
            </View>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.exportTitle}
            </Text>
            <Text style={styles.lead}>{copy.privacyOfflineLead}</Text>
            {record ? (
              <Text accessibilityLiveRegion="polite" style={styles.meta}>
                {exportStatusLabel(record.status)}
              </Text>
            ) : null}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{copy.privacyExportTitle}</Text>
              <Text style={styles.cardBody}>{copy.privacyOfflineExport}</Text>
              <View accessibilityState={{ disabled: true }} style={styles.disabledButton}>
                <Text style={styles.disabledLabel}>{copy.exportStart}</Text>
              </View>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{copy.privacyDeleteTitle}</Text>
              <Text style={styles.cardBody}>{copy.privacyOfflineDelete}</Text>
              <View accessibilityState={{ disabled: true }} style={styles.disabledButton}>
                <Text style={styles.disabledLabel}>{copy.deletionConfirm}</Text>
              </View>
            </View>
          </>
        ) : null}
        {surface === "locked" ? (
          <>
            <View style={styles.hero}>
              <View style={styles.dangerWell}>
                <Text style={styles.lockGlyph}>{"\u25A3"}</Text>
              </View>
              <Text accessibilityRole="header" style={styles.lockedTitle}>
                {copy.privacyLockedTitle}
              </Text>
              <Text style={styles.centerBody}>{copy.privacyLockedBody}</Text>
            </View>
            <View accessibilityLiveRegion="polite" style={styles.card}>
              <View style={styles.dangerChip}>
                <Text style={styles.dangerChipLabel}>{deletionBadge(deletion?.status ?? "locked")}</Text>
              </View>
              <Text style={styles.cardBody}>{deletion ? deletionStatusLabel(deletion.status) : copy.deletionLocked}</Text>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{copy.privacyRequested}</Text>
                <Text style={styles.rowValue}>{copy.privacyRequestedValue}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{copy.privacyPurge}</Text>
                <Text style={styles.rowValue}>{copy.privacyPurgeValue}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{copy.privacyCancel}</Text>
                <Text style={styles.rowValue}>{copy.privacyCancelValue}</Text>
              </View>
              {categories.map((category) => (
                <Text key={category} style={styles.cardBody}>
                  {category}
                </Text>
              ))}
            </View>
            <View style={styles.warn}>
              <Text style={styles.warnTitle}>{copy.privacyAppleTitle}</Text>
              <Text style={styles.warnBody}>{copy.privacyAppleBody}</Text>
            </View>
            <View style={styles.spacer} />
            <Pressable
              accessibilityLabel={copy.deletionManageSubscription}
              accessibilityRole="button"
              onPress={() => void Linking.openURL(APPLE_SUBSCRIPTIONS_URL)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.deletionManageSubscription}</Text>
            </Pressable>
            <Text style={styles.footnote}>{copy.privacyAuthoritative}</Text>
          </>
        ) : null}
        {surface === "preparing" ? (
          <>
            <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.title}>
              {copy.privacyPreparingTitle}
            </Text>
            <Text style={styles.lead}>{copy.privacyPreparingBody}</Text>
            <View style={styles.card}>
              <View style={styles.chip}>
                <Text style={styles.chipLabel}>{copy.privacyPreparingBadge}</Text>
              </View>
              <Text style={styles.cardTitle}>{copy.privacyCreating}</Text>
              <Text style={styles.cardBody}>{copy.privacyLeave}</Text>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{copy.privacyEmail}</Text>
                <Text style={styles.rowValue}>{copy.privacyEmailValue}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{copy.privacyAttachment}</Text>
                <Text style={styles.rowValue}>{copy.privacyAttachmentValue}</Text>
              </View>
            </View>
            <View style={styles.info}>
              <Text style={styles.infoTitle}>{copy.privacyPublishing}</Text>
              <Text style={styles.infoBody}>{copy.privacyPublishingBody}</Text>
            </View>
            <View style={styles.spacer} />
            <View accessibilityState={{ disabled: true, busy: true }} style={styles.disabledButton}>
              <Text style={styles.disabledLabel}>{copy.exportWorking}</Text>
            </View>
            <Text style={styles.footnote}>{copy.privacyRefreshNote}</Text>
          </>
        ) : null}
        {surface === "ready" ? (
          <>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.privacyReadyTitle}
            </Text>
            <Text style={styles.lead}>{copy.privacyReadyBody}</Text>
            <View style={styles.card}>
              <View style={styles.readyChip}>
                <Text style={styles.readyChipLabel}>{copy.privacyReadyBadge}</Text>
              </View>
              <Text style={styles.cardTitle}>{copy.privacyReadyName}</Text>
              <Text style={styles.cardBody}>{copy.privacyReadyOpen}</Text>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{copy.privacyIntegrity}</Text>
                <Text style={styles.rowValue}>{copy.privacyIntegrityValue}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{copy.privacyAvailability}</Text>
                <Text style={styles.rowValue}>{record?.download_until ?? copy.privacyAvailabilityValue}</Text>
              </View>
            </View>
            <View style={styles.info}>
              <Text style={styles.infoTitle}>{copy.privacyPrivateFile}</Text>
              <Text style={styles.infoBody}>{copy.privacyPrivateFileBody}</Text>
            </View>
            {error ? (
              <Text ref={errorRef} accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
            <View style={styles.spacer} />
            <Pressable
              accessibilityLabel={copy.exportDownload}
              accessibilityRole="button"
              accessibilityState={{ disabled: !record?.download_available }}
              disabled={!record?.download_available}
              onPress={() => void download()}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{copy.exportDownload}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={copy.exportNewer}
              accessibilityRole="button"
              accessibilityState={{ disabled: view.exportDisabled, busy: requesting }}
              disabled={view.exportDisabled}
              onPress={() => void requestExport(true)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.exportNewer}</Text>
            </Pressable>
            <Text style={styles.footnote}>{copy.privacyNewerNote}</Text>
          </>
        ) : null}
        {surface === "confirm_deletion" ? (
          <>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.privacyDeleteHeading}
            </Text>
            <Text style={styles.lead}>{copy.privacyDeleteLead}</Text>
            <View style={styles.danger}>
              <Text style={styles.dangerTitle}>{copy.privacyCannotCancel}</Text>
              <Text style={styles.dangerBody}>{copy.privacyCannotCancelBody}</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{copy.privacyBefore}</Text>
              <Text style={styles.cardBody}>{`\u2022 ${copy.privacyBeforeExport}`}</Text>
              <Text style={styles.cardBody}>{`\u2022 ${copy.privacyBeforeApple}`}</Text>
              <Text style={styles.cardBody}>{`\u2022 ${copy.privacyBeforeReceipt}`}</Text>
            </View>
            <Text style={styles.fieldLabel}>{copy.deletionTypeLabel}</Text>
            <TextInput
              accessibilityLabel={copy.deletionTypeLabel}
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={setConfirmation}
              style={styles.input}
              value={confirmation}
            />
            {deletionError ? (
              <Text ref={errorRef} accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.error}>
                {deletionError}
              </Text>
            ) : null}
            <View style={styles.spacer} />
            <Pressable
              accessibilityLabel={copy.deletionConfirm}
              accessibilityRole="button"
              accessibilityState={{ disabled: deletionView.confirmDisabled, busy: deleting }}
              disabled={deletionView.confirmDisabled}
              onPress={() => void requestDeletion()}
              style={[styles.dangerButton, deletionView.confirmDisabled ? styles.disabledButton : null]}
            >
              <Text style={deletionView.confirmDisabled ? styles.disabledLabel : styles.primaryLabel}>
                {deleting ? copy.deletionWorking : copy.deletionConfirm}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={copy.deletionManageSubscription}
              accessibilityRole="button"
              onPress={() => void Linking.openURL(APPLE_SUBSCRIPTIONS_URL)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.deletionManageSubscription}</Text>
            </Pressable>
            <Text style={styles.footnote}>{copy.privacyAppleOutside}</Text>
          </>
        ) : null}
        {surface === "loading" || surface === "overview" ? (
          <>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.exportTitle}
            </Text>
            <Text style={styles.lead}>{copy.privacyIntro}</Text>
            {surface === "loading" ? (
              <View accessibilityLabel={copy.exportLoading} accessibilityRole="progressbar">
                <View style={styles.skeleton} />
                <View style={styles.skeletonShort} />
              </View>
            ) : (
              <>
                {record?.status === "failed" || record?.status === "expired" ? (
                  <View style={styles.chip}>
                    <Text style={styles.chipLabel}>
                      {record.status === "failed" ? copy.privacyFailed : copy.privacyExpired}
                    </Text>
                  </View>
                ) : null}
                {error ? (
                  <Text ref={errorRef} accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.error}>
                    {error}
                  </Text>
                ) : null}
                <View ref={exportRef} style={styles.card}>
                  <Text style={styles.cardTitle}>{copy.privacyExportTitle}</Text>
                  <Text style={styles.cardBody}>{copy.privacyExportBody}</Text>
                  <View style={styles.chip}>
                    <Text style={styles.chipLabel}>{copy.privacyPrivate}</Text>
                  </View>
                  <Text style={styles.cardBody}>{copy.privacyNeverEmail}</Text>
                  <Pressable
                    accessibilityLabel={copy.exportStart}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: view.exportDisabled, busy: requesting }}
                    disabled={view.exportDisabled}
                    onPress={() => void requestExport(false)}
                    style={styles.primary}
                  >
                    <Text style={styles.primaryLabel}>{copy.exportStart}</Text>
                  </Pressable>
                  <Text style={styles.footnote}>{copy.privacyDailyLimit}</Text>
                </View>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{copy.privacyDeleteTitle}</Text>
                  <Text style={styles.cardBody}>{copy.privacyDeleteBody}</Text>
                  <Text style={styles.cardBody}>{copy.privacyDeleteSummary}</Text>
                  <Pressable
                    accessibilityLabel={copy.deletionConfirm}
                    accessibilityRole="button"
                    onPress={() => setConfirming(true)}
                    style={styles.dangerOutline}
                  >
                    <Text style={styles.dangerOutlineLabel}>{copy.deletionConfirm}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </>
        ) : null}
      </ScrollView>
      <Modal animationType="slide" transparent visible={pending !== null} onRequestClose={() => setPendingAction(null)}>
        <View style={styles.scrim}>
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 24) }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.privacyVerifyTitle}
            </Text>
            <Text style={styles.cardBody}>{copy.privacyVerifyBody}</Text>
            <VerifyCodeField
              disabled={auth.submitting}
              hint={copy.verifyHint}
              label={copy.codeLabel}
              onChange={auth.setCode}
              value={auth.code}
            />
            {auth.error ? (
              <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.error}>
                {auth.error}
              </Text>
            ) : null}
            <Pressable
              accessibilityLabel={copy.verifyCode}
              accessibilityRole="button"
              accessibilityState={{
                busy: auth.submitting,
                disabled: !presentVerifyReady(auth.code, auth.snapshot.verifyFailures ?? 0, auth.submitting),
              }}
              disabled={!presentVerifyReady(auth.code, auth.snapshot.verifyFailures ?? 0, auth.submitting)}
              onPress={() => void verifyPending()}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{copy.verifyCode}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={presentResendLabel(auth.resendSeconds)}
              accessibilityRole="button"
              accessibilityState={{ disabled: auth.resendSeconds > 0 }}
              disabled={auth.resendSeconds > 0}
              onPress={() => void auth.sendCode()}
              style={styles.textButton}
            >
              <Text style={styles.textButtonLabel}>{presentResendLabel(auth.resendSeconds)}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={copy.privacyDifferentEmail}
              accessibilityRole="button"
              onPress={() => {
                setPendingAction(null);
                requestAnimationFrame(() => {
                  const node = findNodeHandle(exportRef.current);
                  if (node) {
                    AccessibilityInfo.setAccessibilityFocus(node);
                  }
                });
              }}
              style={styles.textButton}
            >
              <Text style={styles.textButtonLabel}>{copy.privacyDifferentEmail}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  atmosphere: {
    position: "absolute",
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: "#E3EDFC",
    top: -72,
    right: -73,
  },
  content: { flexGrow: 1, paddingHorizontal: 20, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 48 },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backGlyph: { color: TITLE, fontSize: 28, lineHeight: 32 },
  headerCopy: { flex: 1, gap: 2 },
  headerTitle: { color: TITLE, fontSize: 18, fontWeight: "700", lineHeight: 26 },
  headerHint: { color: MUTED, fontSize: 11, lineHeight: 16 },
  title: { color: TITLE, fontSize: 29, fontWeight: "700", lineHeight: 40 },
  lead: { color: MUTED, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    gap: 12,
    width: "100%",
  },
  cardTitle: { color: TITLE, fontSize: 16, fontWeight: "600", lineHeight: 23 },
  cardBody: { color: MUTED, fontSize: 12, lineHeight: 17 },
  chip: { alignSelf: "flex-start", backgroundColor: INFO_BG, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  chipLabel: { color: PRIMARY, fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  readyChip: { alignSelf: "flex-start", backgroundColor: READY_BG, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  readyChipLabel: { color: READY, fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  dangerChip: { alignSelf: "flex-start", backgroundColor: DANGER_BG, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  dangerChipLabel: { color: DANGER, fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  rowLabel: { color: MUTED, fontSize: 11, lineHeight: 16, flex: 1 },
  rowValue: { color: TITLE, fontSize: 11, fontWeight: "600", lineHeight: 16, flex: 1, textAlign: "right" },
  info: { backgroundColor: INFO_BG, borderColor: INFO_LINE, borderWidth: 1, borderRadius: 16, padding: 14, gap: 6 },
  infoTitle: { color: PRIMARY, fontSize: 12, fontWeight: "600", lineHeight: 17 },
  infoBody: { color: MUTED, fontSize: 11, lineHeight: 16 },
  warn: { backgroundColor: WARN_BG, borderColor: WARN_LINE, borderWidth: 1, borderRadius: 16, padding: 14, gap: 6 },
  warnTitle: { color: PRIMARY, fontSize: 12, fontWeight: "600", lineHeight: 17 },
  warnBody: { color: MUTED, fontSize: 11, lineHeight: 16 },
  danger: { backgroundColor: DANGER_BG, borderColor: DANGER, borderWidth: 1, borderRadius: 16, padding: 14, gap: 6 },
  dangerTitle: { color: DANGER, fontSize: 12, fontWeight: "600", lineHeight: 17 },
  dangerBody: { color: MUTED, fontSize: 11, lineHeight: 16 },
  primary: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    width: "100%",
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", lineHeight: 22, textAlign: "center" },
  secondary: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderColor: PRIMARY,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    width: "100%",
  },
  secondaryLabel: { color: PRIMARY, fontSize: 15, fontWeight: "600", lineHeight: 22, textAlign: "center" },
  dangerOutline: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderColor: DANGER,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    width: "100%",
  },
  dangerOutlineLabel: { color: DANGER, fontSize: 15, fontWeight: "600", lineHeight: 22, textAlign: "center" },
  dangerButton: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: DANGER,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    width: "100%",
  },
  disabledButton: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: DISABLED_BG,
    borderColor: DISABLED_LINE,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    width: "100%",
  },
  disabledLabel: { color: DISABLED, fontSize: 15, fontWeight: "600", lineHeight: 22, textAlign: "center" },
  footnote: { color: MUTED, fontSize: 11, lineHeight: 16, textAlign: "center" },
  error: { color: DANGER, fontSize: 13, lineHeight: 18 },
  spacer: { flexGrow: 1, minHeight: 12 },
  fieldLabel: { color: TITLE, fontSize: 12, fontWeight: "600", lineHeight: 17 },
  input: {
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: DANGER,
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    color: TITLE,
    fontSize: 15,
    fontWeight: "600",
  },
  meta: { color: MUTED, fontSize: 12, lineHeight: 17 },
  offline: { backgroundColor: WARN_BG, borderColor: WARN_LINE, borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 },
  offlineTitle: { color: TITLE, fontSize: 13, fontWeight: "600", lineHeight: 19 },
  offlineBody: { color: MUTED, fontSize: 11, lineHeight: 16 },
  hero: { alignItems: "center", gap: 12 },
  dangerWell: {
    width: 88,
    height: 88,
    borderRadius: 28,
    backgroundColor: DANGER_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  lockWell: {
    width: 88,
    height: 88,
    borderRadius: 28,
    backgroundColor: INFO_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  lockGlyph: { color: PRIMARY, fontSize: 28 },
  lockedTitle: { color: TITLE, fontSize: 25, fontWeight: "700", lineHeight: 34, textAlign: "center" },
  centerBody: { color: MUTED, fontSize: 12, lineHeight: 17, textAlign: "center" },
  expired: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingVertical: 48 },
  expiredTitle: { color: TITLE, fontSize: 28, fontWeight: "700", lineHeight: 40, textAlign: "center" },
  expiredBody: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: "center" },
  privacyCard: {
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 6,
    width: "100%",
    maxWidth: 320,
  },
  privacyTitle: { color: TITLE, fontSize: 12, fontWeight: "600", lineHeight: 17, textAlign: "center" },
  privacyBody: { color: MUTED, fontSize: 11, lineHeight: 16, textAlign: "center" },
  skeleton: { height: 120, borderRadius: 20, backgroundColor: LINE },
  skeletonShort: { height: 18, width: "60%", borderRadius: 8, backgroundColor: LINE, marginTop: 12 },
  scrim: { flex: 1, backgroundColor: "rgba(15,18,28,0.44)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 14,
  },
  handle: { width: 44, height: 4, borderRadius: 2, backgroundColor: DISABLED_LINE },
  sheetTitle: { color: TITLE, fontSize: 24, fontWeight: "700", lineHeight: 32 },
  textButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  textButtonLabel: { color: PRIMARY, fontSize: 13, fontWeight: "600", lineHeight: 19 },
});
