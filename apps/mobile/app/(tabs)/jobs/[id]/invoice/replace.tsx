import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../../src/i18n/en.ts";
import {
  dueDateFromOption,
  presentInvoicePreview,
  type InvoicePreviewRecord,
} from "../../../../../src/invoices/presentation.ts";
import { jobDetailPath, jobInvoiceDetailPath } from "../../../../../src/jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../../src/theme.ts";

export default function InvoiceReplaceScreen() {
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
  const [preview, setPreview] = useState<InvoicePreviewRecord | undefined>();
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [dueOption, setDueOption] = useState<"receipt" | "7" | "14" | "30" | "custom">("14");
  const [customDue, setCustomDue] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string } | undefined>();
  const issueKey = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    setLoading(true);
    setError(undefined);
    const result = await runOwnerRequest<InvoicePreviewRecord>({
      path: `/v1/invoices/${invoiceId}/replacement-preview`,
      method: "POST",
      body: {},
    });
    if (result.ok) {
      setPreview(result.data);
      setCustomerName(result.data.snapshot.customer.name);
      setCustomerEmail(result.data.snapshot.customer.email ?? "");
      setInstructions(result.data.snapshot.payment_instructions);
      setCustomDue(result.data.snapshot.due_date);
    } else {
      setError({
        message: result.error.message || copy.invoicePreviewError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
    }
    setLoading(false);
  }, [invoiceId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const view = presentInvoicePreview({
    authStatus: auth.snapshot.status,
    loading,
    confirming,
    issuing,
    preview,
    error,
  });

  async function issue() {
    if (!preview || view.issueDisabled || !invoiceId) {
      return;
    }
    setIssuing(true);
    const dueDate = dueDateFromOption(preview.snapshot.issue_date, dueOption, customDue || preview.snapshot.due_date);
    const refreshed = await runOwnerRequest<InvoicePreviewRecord>({
      path: `/v1/invoices/${invoiceId}/replacement-preview`,
      method: "POST",
      body: {
        due_date: dueDate,
        payment_instructions: instructions || undefined,
        customer: {
          name: customerName || undefined,
          email: customerEmail || undefined,
        },
      },
    });
    if (!refreshed.ok) {
      setIssuing(false);
      setError({
        message: refreshed.error.message || copy.invoicePreviewError,
        retryable: refreshed.error.retryable || refreshed.error.status === 0,
        status: refreshed.error.status,
        code: refreshed.error.code,
      });
      return;
    }
    issueKey.current = retainOrCreateSetupIdempotencyKey(issueKey.current);
    const result = await runOwnerRequest<{ id: string }>({
      path: `/v1/invoices/${invoiceId}/issue-replacement`,
      method: "POST",
      idempotencyKey: issueKey.current,
      body: { preview_hash: refreshed.data.preview_hash },
    });
    setIssuing(false);
    if (result.ok) {
      router.replace(jobInvoiceDetailPath(jobId, result.data.id));
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      issueKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setError({
      message:
        result.error.code === "PREVIEW_CHANGED"
          ? copy.invoiceStalePreview
          : result.error.code === "DOCUMENT_IMMUTABLE"
            ? copy.invoiceDuplicate
            : result.error.message || copy.invoiceIssueError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
      code: result.error.code,
    });
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {copy.invoiceReplaceTitle}
        </Text>
        {view.kind === "loading" ? <ActivityIndicator color={colors.navy} /> : null}
        {view.kind === "offline" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.invoiceOffline}
          </Text>
        ) : null}
        {view.message ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {view.message}
          </Text>
        ) : null}
        {view.showRetry ? (
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{copy.retry}</Text>
          </Pressable>
        ) : null}
        {preview ? (
          <>
            <Text style={styles.banner}>{copy.invoiceReplaceConfirm}</Text>
            <Text style={styles.section}>{copy.quoteTotal}</Text>
            <Text style={styles.body}>{formatUsdCents(preview.snapshot.total_cents)}</Text>
            {preview.snapshot.lines.map((line) => (
              <Text key={line.position} style={styles.body}>
                {line.position}. {line.description} · {formatUsdCents(line.total_cents)}
              </Text>
            ))}
            <Text style={styles.section}>{copy.quoteCustomer}</Text>
            <TextInput
              accessibilityLabel={copy.quoteCustomer}
              value={customerName}
              onChangeText={setCustomerName}
              style={styles.input}
            />
            <TextInput
              accessibilityLabel={copy.quoteRecipientEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              value={customerEmail}
              onChangeText={setCustomerEmail}
              style={styles.input}
            />
            <Text style={styles.section}>{copy.invoiceDueDate}</Text>
            <View style={styles.dueRow}>
              {(
                [
                  ["receipt", copy.invoiceDueReceipt],
                  ["7", copy.invoiceDue7],
                  ["14", copy.invoiceDue14],
                  ["30", copy.invoiceDue30],
                  ["custom", copy.invoiceDueCustom],
                ] as const
              ).map(([option, label]) => (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected: dueOption === option }}
                  onPress={() => setDueOption(option)}
                  style={[styles.dueChip, dueOption === option ? styles.dueChipSelected : null]}
                >
                  <Text style={[styles.dueChipLabel, dueOption === option ? styles.dueChipLabelSelected : null]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {dueOption === "custom" ? (
              <TextInput
                accessibilityLabel={copy.invoiceDueCustom}
                value={customDue}
                onChangeText={setCustomDue}
                placeholder="YYYY-MM-DD"
                style={styles.input}
              />
            ) : (
              <Text style={styles.body}>
                {dueDateFromOption(preview.snapshot.issue_date, dueOption, customDue || preview.snapshot.due_date)}
              </Text>
            )}
            <Text style={styles.section}>{copy.invoicePaymentInstructions}</Text>
            <TextInput
              accessibilityLabel={copy.invoicePaymentInstructions}
              multiline
              value={instructions}
              onChangeText={setInstructions}
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: view.issueDisabled }}
              disabled={view.issueDisabled}
              onPress={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                void issue();
              }}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>
                {issuing ? copy.invoiceIssuing : confirming ? copy.invoiceIssue : copy.invoiceReplace}
              </Text>
            </Pressable>
          </>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => router.replace(jobDetailPath(jobId))} style={styles.secondary}>
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
  body: { color: colors.text, fontSize: type.body },
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
  dueRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  dueChip: {
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
  },
  dueChipSelected: { backgroundColor: colors.navy },
  dueChipLabel: { color: colors.navy, fontSize: type.secondary },
  dueChipLabelSelected: { color: "#FFFFFF" },
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
