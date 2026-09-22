import { formatUsdCents, LINE_UNITS, type LineUnit } from "@job-to-invoice/schemas";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../crypto/uuid.ts";
import { copy } from "../i18n/en.ts";
import { jobDetailPath, jobInvoiceDetailPath } from "../jobs/routes.ts";
import type { JobDetail } from "../jobs/presentation.ts";
import {
  emptyQuoteLine,
  formFromDraft,
  liveTotals,
  payloadFromForm,
  type QuoteDraftRecord,
  type QuoteFormValues,
} from "../quotes/form.ts";
import { lineFromCatalogueItem } from "../items/form.ts";
import { CatalogueItemPicker } from "../items/picker.tsx";
import { retainOrCreateSetupIdempotencyKey } from "../setup/idempotency.ts";
import { useAuth } from "../session/AuthProvider.tsx";
import { colors, space, type } from "../theme.ts";
import { dueDateFromOption, type InvoicePreviewRecord } from "./presentation.ts";

const SAVE_DEBOUNCE_MS = 500;

export type DirectInvoiceDraftRecord = Omit<QuoteDraftRecord, "terms" | "expiry_days"> & {
  direct_invoice: true;
  issue_acknowledgement: boolean;
  due_date: string | null;
  payment_instructions: string;
  customer_email: string | null;
};

function unitLabel(unit: LineUnit): string {
  switch (unit) {
    case "hour":
      return copy.unitHour;
    case "day":
      return copy.unitDay;
    case "square_foot":
      return copy.unitSquareFoot;
    case "linear_foot":
      return copy.unitLinearFoot;
    case "custom":
      return copy.unitCustom;
    default:
      return copy.unitItem;
  }
}

export function DirectInvoiceScreen({ jobId }: { jobId: string }) {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<DirectInvoiceDraftRecord | undefined>();
  const [values, setValues] = useState<QuoteFormValues>({ notes: "", terms: "", expiry_days: "14", lines: [] });
  const [acknowledgement, setAcknowledgement] = useState(false);
  const [dueOption, setDueOption] = useState<"receipt" | "7" | "14" | "30" | "custom">("14");
  const [customDue, setCustomDue] = useState("");
  const [instructions, setInstructions] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string } | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const saveKey = useRef<string | undefined>(undefined);
  const issueKey = useRef<string | undefined>(undefined);
  const versionRef = useRef(1);
  const dirtyRef = useRef(false);
  const offline = auth.snapshot.status === "offline_cached" || auth.snapshot.status === "access_expired";

  const load = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    setLoading(true);
    setError(undefined);
    const jobResult = await runOwnerRequest<JobDetail>({ path: `/v1/jobs/${jobId}` });
    if (!jobResult.ok) {
      setError({
        message: jobResult.error.status === 404 ? copy.jobNotFound : jobResult.error.message || copy.invoicePreviewError,
        retryable: jobResult.error.retryable || jobResult.error.status === 0,
        status: jobResult.error.status,
        code: jobResult.error.code,
      });
      setLoading(false);
      return;
    }
    if (jobResult.data.active_invoice) {
      router.replace(jobInvoiceDetailPath(jobId, jobResult.data.active_invoice.id));
      return;
    }
    const draftId = jobResult.data.invoice_draft?.id;
    if (!draftId) {
      setError({ message: copy.invoiceEmpty, retryable: true, status: 422 });
      setLoading(false);
      return;
    }
    const result = await runOwnerRequest<DirectInvoiceDraftRecord>({ path: `/v1/drafts/${draftId}` });
    if (!result.ok) {
      setError({
        message: result.error.message || copy.invoicePreviewError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
      setLoading(false);
      return;
    }
    setDraft(result.data);
    versionRef.current = result.data.version;
    setValues(formFromDraft({ ...result.data, terms: "", expiry_days: 14 }));
    setAcknowledgement(result.data.issue_acknowledgement);
    setInstructions(result.data.payment_instructions);
    setCustomerEmail(result.data.customer_email ?? "");
    if (result.data.due_date) {
      setCustomDue(result.data.due_date);
      setDueOption("custom");
    }
    setLoading(false);
  }, [jobId, router, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => liveTotals(values), [values]);

  async function saveDraft(next: {
    values: QuoteFormValues;
    acknowledgement: boolean;
    dueDate: string | null;
    instructions: string;
    customerEmail: string;
  }) {
    if (!draft || offline) {
      return undefined;
    }
    const parsed = payloadFromForm(next.values);
    if (!parsed.ok) {
      const nextErrors: Record<string, string> = {};
      for (const item of parsed.field_errors) {
        nextErrors[item.field] = item.message;
      }
      setFieldErrors(nextErrors);
      return undefined;
    }
    setSaving(true);
    saveKey.current = retainOrCreateSetupIdempotencyKey(saveKey.current);
    const result = await runOwnerRequest<DirectInvoiceDraftRecord>({
      path: `/v1/drafts/${draft.id}`,
      method: "PATCH",
      idempotencyKey: saveKey.current,
      ifMatch: versionRef.current,
      body: {
        direct_invoice: true,
        issue_acknowledgement: next.acknowledgement,
        due_date: next.dueDate,
        payment_instructions: next.instructions,
        notes: parsed.value.notes,
        customer_email: next.customerEmail.trim() || null,
        lines: parsed.value.lines,
      },
    });
    setSaving(false);
    if (!result.ok) {
      if (result.error.code === "IDEMPOTENCY_MISMATCH" || result.error.code === "VERSION_CONFLICT") {
        saveKey.current = retainOrCreateSetupIdempotencyKey(undefined);
      }
      setError({
        message: result.error.message || copy.invoicePreviewError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
      return undefined;
    }
    dirtyRef.current = false;
    versionRef.current = result.data.version;
    setDraft(result.data);
    setFieldErrors({});
    return result.data;
  }

  useEffect(() => {
    if (!draft || !dirtyRef.current || offline) {
      return;
    }
    const handle = setTimeout(() => {
      const issueDate = customDue || "2026-01-01";
      const dueDate = dueDateFromOption(customDue || issueDate, dueOption, customDue);
      void saveDraft({
        values,
        acknowledgement,
        dueDate,
        instructions,
        customerEmail,
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [acknowledgement, customDue, customerEmail, draft, dueOption, instructions, offline, values]);

  async function issue() {
    if (!draft || issuing || offline) {
      return;
    }
    const dueDate = dueDateFromOption(customDue || new Date().toISOString().slice(0, 10), dueOption, customDue);
    const saved = await saveDraft({
      values,
      acknowledgement: true,
      dueDate,
      instructions,
      customerEmail,
    });
    if (!saved) {
      return;
    }
    const previewed = await runOwnerRequest<InvoicePreviewRecord>({
      path: `/v1/drafts/${saved.id}/preview`,
      method: "POST",
      ifMatch: saved.version,
    });
    if (!previewed.ok) {
      setError({
        message: previewed.error.message || copy.invoicePreviewError,
        retryable: previewed.error.retryable || previewed.error.status === 0,
        status: previewed.error.status,
        code: previewed.error.code,
      });
      return;
    }
    setIssuing(true);
    issueKey.current = retainOrCreateSetupIdempotencyKey(issueKey.current);
    const result = await runOwnerRequest<{ id: string }>({
      path: `/v1/jobs/${jobId}/issue-invoice`,
      method: "POST",
      idempotencyKey: issueKey.current,
      body: { preview_hash: previewed.data.preview_hash },
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
          : result.error.message || copy.invoiceIssueError,
      retryable: result.error.retryable || result.error.status === 0,
      status: result.error.status,
      code: result.error.code,
    });
  }

  const issueDisabled = offline || issuing || saving || !acknowledgement || !totals.ok || totals.value.lines.length < 1;

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {copy.invoicePreviewTitle}
        </Text>
        <Text style={styles.banner}>{copy.invoiceDirectNotice}</Text>
        {offline ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.invoiceOffline}
          </Text>
        ) : null}
        {loading ? <ActivityIndicator color={colors.navy} /> : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error.message}
          </Text>
        ) : null}
        {error?.retryable ? (
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{copy.retry}</Text>
          </Pressable>
        ) : null}
        {draft ? (
          <>
            <Text style={styles.section}>{copy.invoiceEditLines}</Text>
            {values.lines.map((line, index) => (
              <View key={line.client_line_id} style={styles.card}>
                <TextInput
                  accessibilityLabel={copy.quoteDescription}
                  value={line.description}
                  onChangeText={(description) => {
                    dirtyRef.current = true;
                    setValues((current) => ({
                      ...current,
                      lines: current.lines.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, description } : item,
                      ),
                    }));
                  }}
                  style={styles.input}
                />
                <TextInput
                  accessibilityLabel={copy.quoteQuantity}
                  keyboardType="decimal-pad"
                  value={line.quantity}
                  onChangeText={(quantity) => {
                    dirtyRef.current = true;
                    setValues((current) => ({
                      ...current,
                      lines: current.lines.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, quantity } : item,
                      ),
                    }));
                  }}
                  style={styles.input}
                />
                <View style={styles.dueRow}>
                  {LINE_UNITS.map((unit) => (
                    <Pressable
                      key={unit}
                      accessibilityRole="button"
                      accessibilityState={{ selected: line.unit === unit }}
                      onPress={() => {
                        dirtyRef.current = true;
                        setValues((current) => ({
                          ...current,
                          lines: current.lines.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, unit } : item,
                          ),
                        }));
                      }}
                      style={[styles.dueChip, line.unit === unit ? styles.dueChipSelected : null]}
                    >
                      <Text style={[styles.dueChipLabel, line.unit === unit ? styles.dueChipLabelSelected : null]}>
                        {unitLabel(unit)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  accessibilityLabel={copy.quoteUnitPrice}
                  keyboardType="decimal-pad"
                  value={line.unit_price}
                  onChangeText={(unit_price) => {
                    dirtyRef.current = true;
                    setValues((current) => ({
                      ...current,
                      lines: current.lines.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, unit_price } : item,
                      ),
                    }));
                  }}
                  style={styles.input}
                />
                {fieldErrors[`lines.${index}.description`] ? (
                  <Text accessibilityLiveRegion="polite" style={styles.error}>
                    {fieldErrors[`lines.${index}.description`]}
                  </Text>
                ) : null}
              </View>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                dirtyRef.current = true;
                setValues((current) => ({
                  ...current,
                  lines: [...current.lines, emptyQuoteLine(secureRandomUUID())],
                }));
              }}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.quoteAddLine}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerOpen(true)}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.quoteUseSavedItem}</Text>
            </Pressable>
            <CatalogueItemPicker
              visible={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onPick={(item) => {
                dirtyRef.current = true;
                setValues((current) => ({
                  ...current,
                  lines: [...current.lines, lineFromCatalogueItem(item, secureRandomUUID())],
                }));
              }}
            />
            <Text style={styles.section}>{copy.quoteTotal}</Text>
            <Text style={styles.body}>{totals.ok ? formatUsdCents(totals.totals.total_cents) : copy.invoiceEmpty}</Text>
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
                  onPress={() => {
                    dirtyRef.current = true;
                    setDueOption(option);
                  }}
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
                onChangeText={(value) => {
                  dirtyRef.current = true;
                  setCustomDue(value);
                }}
                placeholder="YYYY-MM-DD"
                style={styles.input}
              />
            ) : null}
            <Text style={styles.section}>{copy.invoicePaymentInstructions}</Text>
            <TextInput
              accessibilityLabel={copy.invoicePaymentInstructions}
              multiline
              value={instructions}
              onChangeText={(value) => {
                dirtyRef.current = true;
                setInstructions(value);
              }}
              style={styles.input}
            />
            <Text style={styles.section}>{copy.invoiceCustomerEmail}</Text>
            <TextInput
              accessibilityLabel={copy.invoiceCustomerEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              value={customerEmail}
              onChangeText={(value) => {
                dirtyRef.current = true;
                setCustomerEmail(value);
              }}
              style={styles.input}
            />
            <View style={styles.ackRow}>
              <Switch
                accessibilityLabel={copy.invoiceDirectAck}
                value={acknowledgement}
                onValueChange={(value) => {
                  dirtyRef.current = true;
                  setAcknowledgement(value);
                }}
              />
              <Text style={styles.body}>{copy.invoiceDirectAck}</Text>
            </View>
            {confirming ? <Text style={styles.banner}>{copy.invoiceDirectConfirm}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: issueDisabled }}
              disabled={issueDisabled}
              onPress={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                void issue();
              }}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{issuing ? copy.invoiceIssuing : copy.invoiceIssue}</Text>
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
  body: { color: colors.text, fontSize: type.body, flex: 1 },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  card: { gap: space.scale, padding: space.scale, borderWidth: 1, borderColor: colors.navy, borderRadius: space.radius },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    padding: space.scale,
    color: colors.text,
    fontSize: type.body,
  },
  dueRow: { flexDirection: "row", flexWrap: "wrap", gap: space.scale },
  dueChip: {
    minHeight: 44,
    paddingHorizontal: space.scale,
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  dueChipSelected: { backgroundColor: colors.navy },
  dueChipLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  dueChipLabelSelected: { color: "#FFFFFF" },
  ackRow: { flexDirection: "row", alignItems: "center", gap: space.scale, minHeight: 44 },
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
