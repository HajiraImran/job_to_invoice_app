import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../../src/i18n/en.ts";
import {
  presentInvoicePdf,
  presentInvoiceStatus,
  canRecordRefund,
  type IssuedInvoiceRecord,
} from "../../../../../src/invoices/presentation.ts";
import { jobCreditPath, jobDetailPath, jobLedgerEntryPath } from "../../../../../src/jobs/routes.ts";
import { useAuth } from "../../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../../src/theme.ts";

export default function InvoiceDetailScreen() {
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
  const [loading, setLoading] = useState(true);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const load = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false);
      setError(copy.jobNotFound);
      return;
    }
    setLoading(true);
    const result = await runOwnerRequest<IssuedInvoiceRecord>({ path: `/v1/documents/${invoiceId}` });
    if (result.ok) {
      setInvoice(result.data);
      setError(undefined);
    } else {
      setError(result.error.message || copy.invoiceIssueError);
    }
    setLoading(false);
  }, [invoiceId, runOwnerRequest]);

  const loadPdf = useCallback(async () => {
    if (!invoiceId) {
      return;
    }
    const result = await runOwnerRequest<{ state: string; url: string | null }>({
      path: `/v1/documents/${invoiceId}/download`,
    });
    if (result.ok && result.data.state === "ready" && result.data.url) {
      setPdfUrl(result.data.url);
    }
  }, [invoiceId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
      void loadPdf();
    }, [load, loadPdf]),
  );

  useEffect(() => {
    if (invoice?.pdf_state === "ready" || invoice?.pdf_state === "failed") {
      return;
    }
    poll.current = setInterval(() => {
      void load();
      void loadPdf();
    }, 3000);
    return () => {
      if (poll.current) {
        clearInterval(poll.current);
      }
    };
  }, [invoice?.pdf_state, load, loadPdf]);

  const pdf = presentInvoicePdf(invoice?.pdf_state ?? "preparing");
  const deliveryLabel =
    invoice?.delivery_state === "delivered"
      ? copy.requestDelivered
      : invoice?.delivery_state === "failed" || invoice?.delivery_state === "bounced"
        ? copy.requestFailed
        : invoice?.delivery_state === "accepted_by_provider"
          ? copy.requestAccepted
          : copy.invoiceDeliveryQueued;

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {copy.invoiceIssueTitle}
        </Text>
        {loading ? <ActivityIndicator color={colors.navy} /> : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {invoice ? (
          <>
            <Text style={styles.section}>{copy.invoiceNumber}</Text>
            <Text style={styles.body}>{invoice.number}</Text>
            <Text style={styles.section}>{copy.quoteTotal}</Text>
            <Text style={styles.body}>{formatUsdCents(invoice.total_cents)}</Text>
            <Text style={styles.section}>{copy.invoiceCredits}</Text>
            <Text style={styles.body}>{formatUsdCents(invoice.credits_cents ?? 0)}</Text>
            <Text style={styles.section}>{copy.invoiceReceived}</Text>
            <Text style={styles.body}>{formatUsdCents(invoice.effective_payments_cents ?? 0)}</Text>
            <Text style={styles.section}>{copy.invoiceRefunded}</Text>
            <Text style={styles.body}>{formatUsdCents(invoice.effective_refunds_cents ?? 0)}</Text>
            <Text style={styles.section}>{copy.invoiceBalance}</Text>
            <Text style={styles.body}>{formatUsdCents(invoice.balance_cents ?? invoice.total_cents)}</Text>
            <Text style={styles.section}>{copy.invoiceDueDate}</Text>
            <Text style={styles.body}>{invoice.due_date}</Text>
            <Text style={styles.body}>{presentInvoiceStatus(invoice.payment_status)}</Text>
            <Text style={styles.banner}>{copy.ledgerRecordedBy}</Text>
            <Text style={styles.section}>{copy.invoiceLedger}</Text>
            {(invoice.entries ?? []).length === 0 ? <Text style={styles.body}>{copy.ledgerEmpty}</Text> : null}
            {(invoice.entries ?? []).map((entry) => (
              <Text key={entry.id} style={styles.body}>
                {entry.effective_date} · {entry.type} · {formatUsdCents(entry.amount_cents)}
              </Text>
            ))}
            <Text accessibilityLiveRegion="polite" style={styles.banner}>
              {pdf.label}
            </Text>
            <Text style={styles.body}>{deliveryLabel}</Text>
            {pdf.canShare && pdfUrl ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.invoiceShare}
                onPress={() => void Linking.openURL(pdfUrl)}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{copy.invoiceShare}</Text>
              </Pressable>
            ) : null}
            {auth.snapshot.status === "offline_cached" ? (
              <Text accessibilityLiveRegion="polite" style={styles.banner}>
                {copy.ledgerOffline}
              </Text>
            ) : (
              <>
                {(invoice.amount_due_cents ?? invoice.total_cents) > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copy.invoiceMarkPaid}
                    disabled={auth.snapshot.status !== "authenticated"}
                    onPress={() => router.push(jobLedgerEntryPath(jobId, invoiceId, "payment"))}
                    style={styles.primary}
                  >
                    <Text style={styles.primaryLabel}>{copy.invoiceMarkPaid}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.invoiceRecordPayment}
                  disabled={auth.snapshot.status !== "authenticated"}
                  onPress={() => router.push(jobLedgerEntryPath(jobId, invoiceId, "payment"))}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.invoiceRecordPayment}</Text>
                </Pressable>
                {canRecordRefund(invoice.payment_status, invoice.amount_to_refund_cents ?? 0) ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copy.invoiceRecordRefund}
                    disabled={auth.snapshot.status !== "authenticated"}
                    onPress={() => router.push(jobLedgerEntryPath(jobId, invoiceId, "refund"))}
                    style={styles.secondary}
                  >
                    <Text style={styles.secondaryLabel}>{copy.invoiceRecordRefund}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.invoiceCredit}
                  disabled={auth.snapshot.status !== "authenticated"}
                  onPress={() => router.push(jobCreditPath(jobId, invoiceId))}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.invoiceCredit}</Text>
                </Pressable>
              </>
            )}
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
