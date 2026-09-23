import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../src/crypto/uuid.ts";
import {
  deletionStatusLabel,
  presentDeletion,
  type DeletionRecord,
} from "../../../src/deletion/presentation.ts";
import { issueDeletionGrant, submitDeletionRequest } from "../../../src/deletion/request-deletion.ts";
import {
  exportStatusLabel,
  presentExport,
  type ExportRecord,
} from "../../../src/export/presentation.ts";
import { issueExportGrant, submitExportRequest } from "../../../src/export/request-export.ts";
import { copy } from "../../../src/i18n/en.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

export default function ExportDataScreen() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const [record, setRecord] = useState<ExportRecord | null | undefined>();
  const [deletion, setDeletion] = useState<DeletionRecord | null | undefined>();
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [deletionStepUp, setDeletionStepUp] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [deletionError, setDeletionError] = useState<string | undefined>();
  const [confirmation, setConfirmation] = useState("");
  const exportKey = useRef(retainOrCreateSetupIdempotencyKey(undefined));
  const deletionKey = useRef(retainOrCreateSetupIdempotencyKey(undefined));
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const loadLatest = useCallback(async () => {
    const result = await auth.runOwnerRequest<{ export: ExportRecord | null }>({
      path: "/v1/exports/latest",
      method: "GET",
    });
    if (result.ok) {
      setRecord(result.data.export);
      setError(undefined);
    } else if (result.error.code === "ACCOUNT_DELETING") {
      setError(undefined);
    } else {
      setError(result.error.message || copy.exportLoadError);
    }
    const deletionResult = await auth.runOwnerRequest<{ deletion: DeletionRecord | null }>({
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
    return result.ok ? result.data.export : undefined;
  }, [auth]);

  useEffect(() => {
    void loadLatest();
    return () => {
      if (poll.current) {
        clearInterval(poll.current);
      }
    };
  }, [loadLatest]);

  function startPolling(id: string) {
    if (poll.current) {
      clearInterval(poll.current);
    }
    poll.current = setInterval(() => {
      void auth
        .runOwnerRequest<ExportRecord>({ path: `/v1/exports/${id}`, method: "GET" })
        .then((result) => {
          if (result.ok) {
            setRecord(result.data);
            if (result.data.status === "ready" || result.data.status === "failed") {
              if (poll.current) {
                clearInterval(poll.current);
              }
              setRequesting(false);
            }
          }
        });
    }, 2500);
  }

  async function requestExport(newer = false) {
    if (auth.snapshot.status === "offline_cached") {
      setError(copy.exportOffline);
      return;
    }
    setRequesting(true);
    setError(undefined);
    const grant = await issueExportGrant((options) => auth.runOwnerRequest(options));
    if (!grant.ok && grant.stepUp) {
      setStepUp(true);
      setRequesting(false);
      const email = auth.emailDisplay || auth.snapshot.emailDisplay || "";
      if (email) {
        auth.setEmailDisplay(email);
      }
      auth.setCode("");
      await auth.sendCode();
      return;
    }
    if (!grant.ok) {
      setRequesting(false);
      setError(grant.error.message || copy.exportStartError);
      return;
    }
    const submitted = await submitExportRequest((options) => auth.runOwnerRequest(options), {
      grant: grant.grant,
      idempotencyKey: newer ? secureRandomUUID() : exportKey.current,
      newer,
    });
    if (!submitted.ok) {
      setRequesting(false);
      setError(submitted.error.message || copy.exportStartError);
      return;
    }
    startPolling(submitted.id);
  }

  async function verifyStepUp() {
    await auth.verifyCode();
    setStepUp(false);
    await requestExport(false);
  }

  async function requestDeletion() {
    if (auth.snapshot.status === "offline_cached") {
      setDeletionError(copy.deletionOffline);
      return;
    }
    if (confirmation !== "DELETE") {
      setDeletionError(copy.deletionTypeLabel);
      return;
    }
    setDeleting(true);
    setDeletionError(undefined);
    const grant = await issueDeletionGrant((options) => auth.runOwnerRequest(options));
    if (!grant.ok && grant.stepUp) {
      setDeletionStepUp(true);
      setDeleting(false);
      const email = auth.emailDisplay || auth.snapshot.emailDisplay || "";
      if (email) {
        auth.setEmailDisplay(email);
      }
      auth.setCode("");
      await auth.sendCode();
      return;
    }
    if (!grant.ok) {
      setDeleting(false);
      setDeletionError(grant.error.message || copy.deletionStartError);
      return;
    }
    const submitted = await submitDeletionRequest((options) => auth.runOwnerRequest(options), {
      grant: grant.grant,
      idempotencyKey: deletionKey.current,
    });
    if (!submitted.ok) {
      setDeleting(false);
      setDeletionError(submitted.error.message || copy.deletionStartError);
      return;
    }
    await loadLatest();
    setDeleting(false);
  }

  async function verifyDeletionStepUp() {
    await auth.verifyCode();
    setDeletionStepUp(false);
    await requestDeletion();
  }

  async function openAppleSubscriptions() {
    await Linking.openURL("https://apps.apple.com/account/subscriptions");
  }

  async function download() {
    if (!record?.id) {
      return;
    }
    const result = await auth.runOwnerRequest<{ url: string }>({
      path: `/v1/exports/${record.id}/download`,
      method: "GET",
    });
    if (!result.ok || !result.data.url) {
      setError(result.ok ? copy.exportDownloadError : result.error.message || copy.exportDownloadError);
      return;
    }
    await Linking.openURL(result.data.url);
  }

  const view = presentExport({
    authStatus: auth.snapshot.status,
    loading,
    requesting,
    stepUp,
    record,
    error,
  });
  const deletionView = presentDeletion({
    authStatus: auth.snapshot.status,
    accountStatus: auth.bootstrap?.user.status,
    requesting: deleting,
    stepUp: deletionStepUp,
    confirmation,
    record: deletion,
    error: deletionError,
  });
  const exportDisabled = view.exportDisabled || deletionView.kind === "locked";

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={[styles.screen, { paddingBottom: insets.bottom + space.gutter }]}>
        <Text accessibilityRole="header" style={styles.title}>
          {copy.exportTitle}
        </Text>
        {view.kind === "offline" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.exportOffline}
          </Text>
        ) : null}
        {view.kind === "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.accessExpired}
          </Text>
        ) : null}
        <Text style={styles.body}>{copy.exportIntro}</Text>
        {loading ? <ActivityIndicator accessibilityLabel={copy.exportLoading} color={colors.navy} /> : null}
        {record ? (
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {exportStatusLabel(record.status)}
            {record.download_until ? ` · ${copy.exportUntil} ${record.download_until}` : ""}
          </Text>
        ) : null}
        {view.message ? (
          <Text accessibilityLiveRegion="assertive" style={styles.banner}>
            {view.message}
          </Text>
        ) : null}
        {stepUp ? (
          <View style={styles.stepUp}>
            <Text style={styles.body}>{copy.exportFreshAuth}</Text>
            <TextInput
              accessibilityLabel={copy.codeLabel}
              keyboardType="number-pad"
              maxLength={6}
              onChangeText={auth.setCode}
              style={styles.input}
              value={auth.code}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.verify}
              onPress={() => void verifyStepUp()}
              style={styles.button}
            >
              <Text style={styles.buttonLabel}>{copy.verify}</Text>
            </Pressable>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.exportStart}
          disabled={exportDisabled}
          onPress={() => void requestExport(false)}
          style={[styles.button, exportDisabled ? styles.disabled : null]}
        >
          <Text style={styles.buttonLabel}>{requesting ? copy.exportWorking : copy.exportStart}</Text>
        </Pressable>
        {record?.status === "ready" ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.exportDownload}
              disabled={!record.download_available}
              onPress={() => void download()}
              style={styles.button}
            >
              <Text style={styles.buttonLabel}>{copy.exportDownload}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.exportNewer}
              onPress={() => void requestExport(true)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.exportNewer}</Text>
            </Pressable>
          </>
        ) : null}
        <Text accessibilityRole="header" style={styles.title}>
          {copy.deletionTitle}
        </Text>
        <Text style={styles.body}>{copy.deletionIntro}</Text>
        <Text style={styles.body}>{copy.deletionWarningLinks}</Text>
        <Text style={styles.body}>{copy.deletionWarningKeep}</Text>
        <Text style={styles.body}>{copy.deletionWarningCancel}</Text>
        <Text style={styles.body}>{copy.deletionApple}</Text>
        {deletion ? (
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {deletionStatusLabel(deletion.status)}
            {deletion.purge_deadline ? ` · ${deletion.purge_deadline}` : ""}
          </Text>
        ) : deletionView.kind === "locked" ? (
          <Text accessibilityLiveRegion="polite" style={styles.body}>
            {copy.deletionLocked}
          </Text>
        ) : null}
        {deletionView.message ? (
          <Text accessibilityLiveRegion="assertive" style={styles.banner}>
            {deletionView.message}
          </Text>
        ) : null}
        {deletionStepUp ? (
          <View style={styles.stepUp}>
            <Text style={styles.body}>{copy.deletionFreshAuth}</Text>
            <TextInput
              accessibilityLabel={copy.codeLabel}
              keyboardType="number-pad"
              maxLength={6}
              onChangeText={auth.setCode}
              style={styles.input}
              value={auth.code}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.verify}
              onPress={() => void verifyDeletionStepUp()}
              style={styles.button}
            >
              <Text style={styles.buttonLabel}>{copy.verify}</Text>
            </Pressable>
          </View>
        ) : null}
        {deletionView.kind !== "locked" ? (
          <>
            <TextInput
              accessibilityLabel={copy.deletionTypeLabel}
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={setConfirmation}
              style={styles.input}
              value={confirmation}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.deletionConfirm}
              disabled={deletionView.confirmDisabled}
              onPress={() => void requestDeletion()}
              style={[styles.danger, deletionView.confirmDisabled ? styles.disabled : null]}
            >
              <Text style={styles.buttonLabel}>{deleting ? copy.deletionWorking : copy.deletionConfirm}</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.deletionManageSubscription}
          onPress={() => void openAppleSubscriptions()}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>{copy.deletionManageSubscription}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  screen: { padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.secondary, fontSize: type.body },
  banner: { color: colors.navy, fontSize: type.secondary },
  stepUp: { gap: space.scale },
  input: {
    minHeight: 44,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    paddingHorizontal: space.scale,
    color: colors.text,
    fontSize: type.body,
  },
  button: {
    minHeight: 44,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonLabel: { color: colors.background, fontSize: type.body, fontWeight: "600" },
  secondary: {
    minHeight: 44,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  danger: {
    minHeight: 44,
    backgroundColor: colors.danger,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
});
