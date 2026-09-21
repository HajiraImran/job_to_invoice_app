import { dollarsStringToCents, formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../../src/i18n/en.ts";
import { type IssuedInvoiceRecord } from "../../../../../src/invoices/presentation.ts";
import { jobInvoiceDetailPath } from "../../../../../src/jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../../src/theme.ts";

const METHODS = [
  { id: "cash" as const, label: copy.ledgerMethodCash },
  { id: "check" as const, label: copy.ledgerMethodCheck },
  { id: "bank_transfer" as const, label: copy.ledgerMethodBank },
  { id: "external_card" as const, label: copy.ledgerMethodCard },
  { id: "other" as const, label: copy.ledgerMethodOther },
];

function centsToDollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}

function todayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function LedgerEntryScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[]; invoiceId?: string | string[]; kind?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  const invoiceId =
    typeof params.invoiceId === "string"
      ? params.invoiceId
      : Array.isArray(params.invoiceId)
        ? (params.invoiceId[0] ?? "")
        : "";
  const kindRaw = typeof params.kind === "string" ? params.kind : Array.isArray(params.kind) ? (params.kind[0] ?? "") : "";
  const kind = kindRaw === "refund" ? "refund" : "payment";
  const [invoice, setInvoice] = useState<IssuedInvoiceRecord | undefined>();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayYmd());
  const [method, setMethod] = useState<(typeof METHODS)[number]["id"]>("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [confirmOverpay, setConfirmOverpay] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
    const result = await runOwnerRequest<IssuedInvoiceRecord>({ path: `/v1/invoices/${invoiceId}/ledger` });
    if (result.ok) {
      setInvoice(result.data);
      setError(undefined);
      if (kind === "refund") {
        setAmount(centsToDollars(result.data.amount_to_refund_cents ?? 0));
      } else {
        setAmount(centsToDollars(result.data.amount_due_cents ?? result.data.total_cents));
      }
    } else {
      setError(result.error.message || copy.ledgerError);
    }
    setLoading(false);
  }, [invoiceId, kind, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const parsedAmount = dollarsStringToCents(amount);
  const amountCents = parsedAmount.ok ? parsedAmount.value : 0;
  const due = invoice?.amount_due_cents ?? invoice?.total_cents ?? 0;
  const overpay = kind === "payment" && parsedAmount.ok && amountCents > due;
  const refundBlocked = kind === "refund" && (invoice?.amount_to_refund_cents ?? 0) <= 0;
  const saveDisabled =
    saving ||
    offline ||
    auth.snapshot.status !== "authenticated" ||
    !parsedAmount.ok ||
    amountCents < 1 ||
    !date ||
    refundBlocked ||
    (overpay && !confirmOverpay);

  async function save() {
    if (saveDisabled || !invoiceId) {
      return;
    }
    setSaving(true);
    key.current = retainOrCreateSetupIdempotencyKey(key.current);
    const path = kind === "refund" ? `/v1/invoices/${invoiceId}/refunds` : `/v1/invoices/${invoiceId}/payments`;
    const body =
      kind === "refund"
        ? {
            amount_cents: amountCents,
            effective_date: date,
            method,
            reference: reference || undefined,
            note: note || undefined,
          }
        : {
            amount_cents: amountCents,
            effective_date: date,
            method,
            reference: reference || undefined,
            note: note || undefined,
            confirm_overpayment: confirmOverpay,
          };
    const result = await runOwnerRequest({
      path,
      method: "POST",
      idempotencyKey: key.current,
      body,
    });
    setSaving(false);
    if (result.ok) {
      router.replace(jobInvoiceDetailPath(jobId, invoiceId));
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      key.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    setError(result.error.message || copy.ledgerError);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {kind === "refund" ? copy.ledgerRefundTitle : copy.ledgerPaymentTitle}
        </Text>
        {loading ? <ActivityIndicator color={colors.navy} /> : null}
        <Text style={styles.banner}>{copy.ledgerWarning}</Text>
        {kind === "refund" ? <Text style={styles.banner}>{copy.ledgerRefundWarning}</Text> : null}
        <Text style={styles.body}>{copy.ledgerRecordedBy}</Text>
        {offline ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {copy.ledgerOffline}
          </Text>
        ) : null}
        {refundBlocked ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {copy.ledgerRefundBlocked}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {invoice ? (
          <>
            <Text style={styles.section}>{copy.invoiceBalance}</Text>
            <Text style={styles.body}>{formatUsdCents(invoice.balance_cents ?? invoice.total_cents)}</Text>
            <Text style={styles.section}>{copy.ledgerAmount}</Text>
            <TextInput
              accessibilityLabel={copy.ledgerAmount}
              keyboardType="decimal-pad"
              onChangeText={setAmount}
              style={styles.input}
              value={amount}
            />
            <Text style={styles.section}>{copy.ledgerDate}</Text>
            <TextInput accessibilityLabel={copy.ledgerDate} onChangeText={setDate} style={styles.input} value={date} />
            <Text style={styles.section}>{copy.ledgerMethod}</Text>
            {METHODS.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                onPress={() => setMethod(item.id)}
                style={[styles.option, method === item.id ? styles.optionOn : null]}
              >
                <Text style={styles.body}>{item.label}</Text>
              </Pressable>
            ))}
            <Text style={styles.section}>{copy.ledgerReference}</Text>
            <TextInput
              accessibilityLabel={copy.ledgerReference}
              onChangeText={setReference}
              style={styles.input}
              value={reference}
            />
            <Text style={styles.section}>{copy.ledgerNote}</Text>
            <TextInput
              accessibilityLabel={copy.ledgerNote}
              multiline
              onChangeText={setNote}
              style={[styles.input, styles.note]}
              value={note}
            />
            {overpay ? (
              <Pressable accessibilityRole="button" onPress={() => setConfirmOverpay((value) => !value)} style={styles.option}>
                <Text style={styles.body}>
                  {confirmOverpay ? "☑ " : "☐ "}
                  {copy.ledgerOverpayConfirm} {formatUsdCents(amountCents - due)}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saveDisabled }}
              disabled={saveDisabled}
              onPress={() => void save()}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{saving ? copy.ledgerSaving : copy.ledgerSave}</Text>
            </Pressable>
          </>
        ) : null}
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
  note: { minHeight: 96, textAlignVertical: "top" },
  option: {
    minHeight: 44,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.scale,
  },
  optionOn: { backgroundColor: "#E8EEF5" },
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
