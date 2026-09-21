import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../../src/i18n/en.ts";
import { canVoidInvoice, type IssuedInvoiceRecord } from "../../../../../src/invoices/presentation.ts";
import { jobInvoiceDetailPath } from "../../../../../src/jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../../src/theme.ts";

export default function InvoiceVoidScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[]; invoiceId?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  const invoiceId =
    typeof params.invoiceId === "string"
      ? params.invoiceId
      : Array.isArray(params.invoiceId)
        ? (params.invoiceId[0] ?? "")
        : "";
  const [invoice, setInvoice] = useState<IssuedInvoiceRecord | undefined>();
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const key = useRef<string | undefined>(undefined);
  const offline = auth.snapshot.status === "offline_cached";
  const eligible = invoice ? canVoidInvoice(invoice) : false;
  const saveDisabled =
    saving || offline || auth.snapshot.status !== "authenticated" || reason.trim().length < 5 || !eligible;

  const load = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false);
      setError(copy.jobNotFound);
      return;
    }
    setLoading(true);
    const result = await runOwnerRequest<IssuedInvoiceRecord>({ path: `/v1/invoices/${invoiceId}/ledger` });
    if (result.ok) {
      setInvoice(result.data);
      setError(undefined);
    } else {
      setError(result.error.message || copy.invoiceVoidError);
    }
    setLoading(false);
  }, [invoiceId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function save() {
    if (saveDisabled || !invoiceId) {
      return;
    }
    setSaving(true);
    setError(undefined);
    key.current = retainOrCreateSetupIdempotencyKey(key.current);
    const result = await runOwnerRequest<IssuedInvoiceRecord>({
      path: `/v1/invoices/${invoiceId}/void`,
      method: "POST",
      headers: { "Idempotency-Key": key.current },
      body: { reason: reason.trim() },
    });
    setSaving(false);
    if (result.ok) {
      router.replace(jobInvoiceDetailPath(jobId, invoiceId));
      return;
    }
    if (result.error.code === "LEDGER_BLOCKS_VOID") {
      setError(copy.invoiceVoidBlocked);
      return;
    }
    setError(result.error.message || copy.invoiceVoidError);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {copy.invoiceVoidTitle}
        </Text>
        {loading ? <ActivityIndicator color={colors.navy} /> : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {offline ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.invoiceVoidOffline}
          </Text>
        ) : null}
        <Text style={styles.banner}>{copy.invoiceVoidWarning}</Text>
        {!eligible && invoice ? <Text style={styles.banner}>{copy.invoiceVoidBlocked}</Text> : null}
        <Text style={styles.section}>{copy.invoiceVoidReason}</Text>
        <TextInput
          accessibilityLabel={copy.invoiceVoidReason}
          editable={!offline && eligible}
          multiline
          value={reason}
          onChangeText={setReason}
          style={[styles.input, styles.reason]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.invoiceVoidConfirm}
          disabled={saveDisabled}
          onPress={() => void save()}
          style={styles.primary}
        >
          <Text style={styles.primaryLabel}>{saving ? copy.invoiceVoiding : copy.invoiceVoidConfirm}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace(jobInvoiceDetailPath(jobId, invoiceId))}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>{copy.back}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  section: { color: colors.text, fontSize: type.section, fontWeight: "600", marginTop: space.scale },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.scale,
    color: colors.text,
    fontSize: type.body,
  },
  reason: { minHeight: 96, textAlignVertical: "top" },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    backgroundColor: colors.navy,
    marginTop: space.gutter,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "700" },
  secondary: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
    marginTop: space.gutter,
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});
