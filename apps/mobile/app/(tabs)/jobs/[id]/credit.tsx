import { dollarsStringToCents, formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../src/i18n/en.ts";
import { type IssuedInvoiceRecord } from "../../../../src/invoices/presentation.ts";
import { jobInvoiceDetailPath } from "../../../../src/jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

type CreditSource = {
  invoice_line_id: string;
  description: string;
  remaining_net_cents: number;
};

type CreditPreview = {
  preview_hash: string;
  snapshot: {
    reason: string;
    invoice_number: string;
    net_cents: number;
    tax_cents: number;
    total_cents: number;
  };
};

function centsToDollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}

export default function CreditNoteScreen() {
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
  const [invoice, setInvoice] = useState<IssuedInvoiceRecord & { credit_sources?: CreditSource[] }>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<CreditPreview | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const key = useRef<string | undefined>(undefined);
  const offline = auth.snapshot.status === "offline_cached";

  const load = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false);
      setError(copy.jobNotFound);
      return;
    }
    setLoading(true);
    const result = await runOwnerRequest<IssuedInvoiceRecord & { credit_sources?: CreditSource[] }>({
      path: `/v1/invoices/${invoiceId}/ledger`,
    });
    if (result.ok) {
      setInvoice(result.data);
      setError(undefined);
      const next: Record<string, string> = {};
      for (const source of result.data.credit_sources ?? []) {
        next[source.invoice_line_id] = "";
      }
      setAmounts(next);
    } else {
      setError(result.error.message || copy.creditError);
    }
    setLoading(false);
  }, [invoiceId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function previewCredit() {
    if (!invoiceId || offline) {
      return;
    }
    const allocations = Object.entries(amounts)
      .map(([invoice_line_id, value]) => {
        const parsed = dollarsStringToCents(value);
        return parsed.ok && parsed.value > 0 ? { invoice_line_id, net_credit_cents: parsed.value } : undefined;
      })
      .filter((row): row is { invoice_line_id: string; net_credit_cents: number } => Boolean(row));
    setSaving(true);
    setError(undefined);
    const result = await runOwnerRequest<CreditPreview>({
      path: `/v1/invoices/${invoiceId}/credits/preview`,
      method: "POST",
      body: { reason, allocations },
    });
    setSaving(false);
    if (result.ok) {
      setPreview(result.data);
      setConfirming(true);
      return;
    }
    setError(result.error.message || copy.creditError);
  }

  async function issueCredit() {
    if (!invoiceId || !preview || offline) {
      return;
    }
    setSaving(true);
    setError(undefined);
    key.current = retainOrCreateSetupIdempotencyKey(key.current);
    const result = await runOwnerRequest<{ id: string }>({
      path: `/v1/invoices/${invoiceId}/credits`,
      method: "POST",
      headers: { "Idempotency-Key": key.current },
      body: { preview_hash: preview.preview_hash },
    });
    setSaving(false);
    if (result.ok) {
      router.replace(jobInvoiceDetailPath(jobId, invoiceId));
      return;
    }
    setError(result.error.message || copy.creditError);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {copy.creditTitle}
        </Text>
        {loading ? <ActivityIndicator color={colors.navy} /> : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {offline ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.creditOffline}
          </Text>
        ) : null}
        <Text style={styles.banner}>{copy.creditNoRefund}</Text>
        {(invoice?.credit_sources ?? []).map((source) => (
          <View key={source.invoice_line_id}>
            <Text style={styles.section}>{source.description}</Text>
            <Text style={styles.body}>
              {copy.creditRemaining}: {formatUsdCents(source.remaining_net_cents)}
            </Text>
            <TextInput
              accessibilityLabel={copy.creditAmount}
              keyboardType="decimal-pad"
              editable={!offline && !confirming}
              value={amounts[source.invoice_line_id] ?? ""}
              onChangeText={(value) => setAmounts((current) => ({ ...current, [source.invoice_line_id]: value }))}
              placeholder={centsToDollars(0)}
              style={styles.input}
            />
          </View>
        ))}
        <Text style={styles.section}>{copy.creditReason}</Text>
        <TextInput
          accessibilityLabel={copy.creditReason}
          editable={!offline && !confirming}
          multiline
          value={reason}
          onChangeText={setReason}
          style={[styles.input, styles.reason]}
        />
        {preview ? (
          <>
            <Text style={styles.section}>{copy.quoteTotal}</Text>
            <Text style={styles.body}>{formatUsdCents(preview.snapshot.total_cents)}</Text>
            <Text style={styles.banner}>{copy.creditIrreversible}</Text>
          </>
        ) : null}
        {confirming ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.creditIssue}
            disabled={saving || offline || auth.snapshot.status !== "authenticated"}
            onPress={() => void issueCredit()}
            style={styles.primary}
          >
            <Text style={styles.primaryLabel}>{saving ? copy.creditIssuing : copy.creditIssue}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.creditPreview}
            disabled={saving || offline || auth.snapshot.status !== "authenticated"}
            onPress={() => void previewCredit()}
            style={styles.primary}
          >
            <Text style={styles.primaryLabel}>{saving ? copy.creditPreviewing : copy.creditPreview}</Text>
          </Pressable>
        )}
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
