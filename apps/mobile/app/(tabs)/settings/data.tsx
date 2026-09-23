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
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const exportKey = useRef(retainOrCreateSetupIdempotencyKey(undefined));
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const loadLatest = useCallback(async () => {
    const result = await auth.runOwnerRequest<{ export: ExportRecord | null }>({
      path: "/v1/exports/latest",
      method: "GET",
    });
    if (result.ok) {
      setRecord(result.data.export);
      setError(undefined);
    } else {
      setError(result.error.message || copy.exportLoadError);
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
          disabled={view.exportDisabled}
          onPress={() => void requestExport(false)}
          style={[styles.button, view.exportDisabled ? styles.disabled : null]}
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
        <Text style={styles.note}>{copy.exportDeletionDeferred}</Text>
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
  note: { color: colors.secondary, fontSize: type.secondary, marginTop: space.gutter },
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
});
