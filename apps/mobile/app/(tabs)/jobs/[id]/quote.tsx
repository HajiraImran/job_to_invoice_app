import { formatUsdCents, LINE_UNITS, type LineUnit } from "@job-to-invoice/schemas";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../../src/crypto/uuid.ts";
import { copy } from "../../../../src/i18n/en.ts";
import { jobDetailPath } from "../../../../src/jobs/routes.ts";
import {
  emptyQuoteLine,
  formFromDraft,
  liveTotals,
  moveLine,
  payloadFromForm,
  type QuoteDraftRecord,
  type QuoteFormValues,
  type QuoteLineForm,
} from "../../../../src/quotes/form.ts";
import { presentQuoteEditor, type QuoteSaveStatus } from "../../../../src/quotes/presentation.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../../src/setup/idempotency.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

const SAVE_DEBOUNCE_MS = 500;

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

export default function QuoteEditorScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const jobId = typeof params.id === "string" ? params.id : "";
  const [draft, setDraft] = useState<QuoteDraftRecord | undefined>();
  const [values, setValues] = useState<QuoteFormValues>({ notes: "", terms: "", expiry_days: "14", lines: [] });
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<QuoteSaveStatus>("idle");
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string } | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const openKey = useRef<string | undefined>(undefined);
  const saveKey = useRef<string | undefined>(undefined);
  const versionRef = useRef(1);
  const dirtyRef = useRef(false);

  const load = useCallback(async () => {
    if (!jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    setLoading(true);
    setError(undefined);
    setSaveStatus("idle");
    openKey.current = retainOrCreateSetupIdempotencyKey(openKey.current);
    const result = await runOwnerRequest<QuoteDraftRecord>({
      path: `/v1/jobs/${jobId}/quote`,
      method: "POST",
      idempotencyKey: openKey.current,
    });
    if (result.ok) {
      setDraft(result.data);
      setValues(formFromDraft(result.data));
      versionRef.current = result.data.version;
      dirtyRef.current = false;
      setFieldErrors({});
    } else {
      setError({
        message:
          result.error.code === "VALIDATION_FAILED" && result.error.field_errors?.some((item) => item.field === "mode")
            ? copy.quoteDirectBlocked
            : result.error.message || copy.quoteLoadError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
    }
    setLoading(false);
  }, [jobId, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const computed = useMemo(() => liveTotals(values), [values]);

  const persist = useCallback(
    async (reason: "debounce" | "button") => {
      if (!draft) {
        return;
      }
      if (auth.snapshot.status === "offline_cached" || auth.snapshot.status === "access_expired") {
        setSaveStatus("offline");
        return;
      }
      const parsed = payloadFromForm(values);
      if (!parsed.ok) {
        const next: Record<string, string> = {};
        for (const item of parsed.field_errors) {
          next[item.field] = item.message;
        }
        setFieldErrors(next);
        setSaveStatus("validation");
        return;
      }
      const live = liveTotals(values);
      if (!live.ok) {
        const next: Record<string, string> = {};
        for (const item of live.field_errors) {
          next[item.field] = item.message;
        }
        setFieldErrors(next);
        setSaveStatus("validation");
        return;
      }
      setSaveStatus("saving");
      setFieldErrors({});
      saveKey.current = retainOrCreateSetupIdempotencyKey(reason === "button" ? undefined : saveKey.current);
      const result = await runOwnerRequest<QuoteDraftRecord>({
        path: `/v1/drafts/${draft.id}`,
        method: "PATCH",
        body: parsed.value,
        idempotencyKey: saveKey.current,
        ifMatch: versionRef.current,
      });
      if (result.ok) {
        setDraft(result.data);
        versionRef.current = result.data.version;
        dirtyRef.current = false;
        setSaveStatus("saved");
        return;
      }
      if (result.error.code === "VERSION_CONFLICT") {
        setSaveStatus("conflict");
        setError({
          message: copy.quoteConflict,
          retryable: true,
          status: result.error.status,
          code: result.error.code,
        });
        return;
      }
      if (result.error.code === "IDEMPOTENCY_MISMATCH") {
        saveKey.current = retainOrCreateSetupIdempotencyKey(undefined);
      }
      if (result.error.field_errors) {
        const next: Record<string, string> = {};
        for (const item of result.error.field_errors) {
          next[item.field] = item.message;
        }
        setFieldErrors(next);
        setSaveStatus("validation");
        return;
      }
      setSaveStatus("error");
      setError({
        message: result.error.message || copy.quoteSaveError,
        retryable: result.error.retryable || result.error.status === 0,
        status: result.error.status,
        code: result.error.code,
      });
    },
    [auth.snapshot.status, draft, runOwnerRequest, values],
  );

  useEffect(() => {
    if (!draft || !dirtyRef.current || saveStatus === "conflict") {
      return;
    }
    if (!liveTotals(values).ok) {
      return;
    }
    const handle = setTimeout(() => {
      void persist("debounce");
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, persist, saveStatus, values]);

  function updateForm(next: QuoteFormValues) {
    dirtyRef.current = true;
    saveKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    setValues(next);
    if (saveStatus === "conflict") {
      return;
    }
    setSaveStatus("idle");
  }

  function updateLine(index: number, patch: Partial<QuoteLineForm>) {
    updateForm({
      ...values,
      lines: values.lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    });
  }

  const view = presentQuoteEditor({
    authStatus: auth.snapshot.status,
    loading,
    draft,
    error,
    saveStatus,
  });
  const saveDisabled =
    saveStatus === "saving" ||
    saveStatus === "conflict" ||
    auth.snapshot.status === "offline_cached" ||
    auth.snapshot.status === "access_expired";

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {copy.quoteEditorTitle}
        </Text>
        <Text style={styles.hint}>{copy.quoteCurrency}</Text>
        {auth.snapshot.status === "offline_cached" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.quoteOffline}
          </Text>
        ) : null}
        {view.kind === "loading" ? <ActivityIndicator color={colors.navy} /> : null}
        {view.kind === "error" || view.kind === "offline" || view.kind === "missing" || view.kind === "access_expired" ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.kind === "access_expired" ? copy.accessExpired : view.message ?? copy.quoteLoadError}
            </Text>
            {view.showRetry ? (
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.retry}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
        {view.kind === "conflict" ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {copy.quoteConflict}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.primary}>
              <Text style={styles.primaryLabel}>{copy.quoteKeepServer}</Text>
            </Pressable>
          </>
        ) : null}

        {draft && view.kind !== "conflict" ? (
          <>
            {values.lines.map((line, index) => (
              <View key={line.client_line_id} style={styles.card} accessibilityLabel={`${copy.quoteLine} ${index + 1}`}>
                <Text style={styles.section}>
                  {copy.quoteLine} {index + 1}
                </Text>
                <Text style={styles.label}>{copy.quoteDescription}</Text>
                <TextInput
                  value={line.description}
                  onChangeText={(value) => updateLine(index, { description: value })}
                  style={styles.input}
                  accessibilityLabel={copy.quoteDescription}
                />
                {fieldErrors[`lines.${index}.description`] ? (
                  <Text style={styles.error}>{fieldErrors[`lines.${index}.description`]}</Text>
                ) : null}
                <Text style={styles.label}>{copy.quoteQuantity}</Text>
                <TextInput
                  value={line.quantity}
                  onChangeText={(value) => updateLine(index, { quantity: value })}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  accessibilityLabel={copy.quoteQuantity}
                />
                <Text style={styles.label}>{copy.quoteUnit}</Text>
                <View style={styles.chips}>
                  {LINE_UNITS.map((unit) => (
                    <Pressable
                      key={unit}
                      accessibilityRole="button"
                      accessibilityState={{ selected: line.unit === unit }}
                      onPress={() => updateLine(index, { unit, custom_unit_label: unit === "custom" ? line.custom_unit_label : "" })}
                      style={[styles.chip, line.unit === unit ? styles.chipOn : null]}
                    >
                      <Text style={line.unit === unit ? styles.chipOnLabel : styles.chipLabel}>{unitLabel(unit)}</Text>
                    </Pressable>
                  ))}
                </View>
                {line.unit === "custom" ? (
                  <>
                    <Text style={styles.label}>{copy.quoteCustomUnit}</Text>
                    <TextInput
                      value={line.custom_unit_label}
                      onChangeText={(value) => updateLine(index, { custom_unit_label: value })}
                      style={styles.input}
                      accessibilityLabel={copy.quoteCustomUnit}
                    />
                  </>
                ) : null}
                <Text style={styles.label}>{copy.quoteUnitPrice}</Text>
                <TextInput
                  value={line.unit_price}
                  onChangeText={(value) => updateLine(index, { unit_price: value })}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  accessibilityLabel={copy.quoteUnitPrice}
                />
                <Text style={styles.label}>{copy.quoteDiscount}</Text>
                <TextInput
                  value={line.discount}
                  onChangeText={(value) => updateLine(index, { discount: value })}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  accessibilityLabel={copy.quoteDiscount}
                />
                <Text style={styles.label}>{copy.quoteTax}</Text>
                <TextInput
                  value={line.tax_percent}
                  onChangeText={(value) => updateLine(index, { tax_percent: value })}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  accessibilityLabel={copy.quoteTax}
                />
                <View style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copy.quoteMoveUp}
                    disabled={index === 0}
                    onPress={() => updateForm({ ...values, lines: moveLine(values.lines, index, -1) })}
                    style={styles.tiny}
                  >
                    <Text style={styles.secondaryLabel}>{copy.quoteMoveUp}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copy.quoteMoveDown}
                    disabled={index === values.lines.length - 1}
                    onPress={() => updateForm({ ...values, lines: moveLine(values.lines, index, 1) })}
                    style={styles.tiny}
                  >
                    <Text style={styles.secondaryLabel}>{copy.quoteMoveDown}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={copy.quoteDeleteLine}
                    onPress={() =>
                      updateForm({ ...values, lines: values.lines.filter((_, lineIndex) => lineIndex !== index) })
                    }
                    style={styles.tiny}
                  >
                    <Text style={styles.error}>{copy.quoteDeleteLine}</Text>
                  </Pressable>
                </View>
              </View>
            ))}

            <Pressable
              accessibilityRole="button"
              onPress={() =>
                updateForm({
                  ...values,
                  lines: [...values.lines, emptyQuoteLine(secureRandomUUID(), draft.default_tax_bp)],
                })
              }
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.quoteAddLine}</Text>
            </Pressable>

            <Text style={styles.label}>{copy.quoteNotes}</Text>
            <TextInput
              value={values.notes}
              onChangeText={(notes) => updateForm({ ...values, notes })}
              multiline
              style={[styles.input, styles.multiline]}
              accessibilityLabel={copy.quoteNotes}
            />
            <Text style={styles.label}>{copy.quoteTerms}</Text>
            <TextInput
              value={values.terms}
              onChangeText={(terms) => updateForm({ ...values, terms })}
              multiline
              style={[styles.input, styles.multiline]}
              accessibilityLabel={copy.quoteTerms}
            />
            <Text style={styles.label}>{copy.quoteExpiry}</Text>
            <TextInput
              value={values.expiry_days}
              onChangeText={(expiry_days) => updateForm({ ...values, expiry_days })}
              keyboardType="number-pad"
              style={styles.input}
              accessibilityLabel={copy.quoteExpiry}
            />

            <Text style={styles.section}>{copy.quoteSubtotal}</Text>
            <Text style={styles.body}>{formatUsdCents(computed.ok ? computed.totals.net_cents : 0)}</Text>
            <Text style={styles.section}>{copy.quoteTaxTotal}</Text>
            <Text style={styles.body}>{formatUsdCents(computed.ok ? computed.totals.tax_cents : 0)}</Text>
            <Text style={styles.section}>{copy.quoteTotal}</Text>
            <Text style={styles.body}>{formatUsdCents(computed.ok ? computed.totals.total_cents : 0)}</Text>
            <Text accessibilityLiveRegion="polite" style={styles.banner}>
              {saveStatus === "saving"
                ? copy.quoteSaving
                : saveStatus === "saved"
                  ? copy.quoteSaved
                  : saveStatus === "validation"
                    ? copy.jobRequired
                    : saveStatus === "error"
                      ? copy.quoteSaveError
                      : saveStatus === "offline"
                        ? copy.quoteOffline
                        : ""}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: saveDisabled }}
              disabled={saveDisabled}
              onPress={() => void persist("button")}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{saveStatus === "saving" ? copy.quoteSaving : copy.quoteSave}</Text>
            </Pressable>
          </>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace(jobDetailPath(jobId))}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>{copy.back}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  section: { color: colors.text, fontSize: type.section, fontWeight: "600", marginTop: space.scale },
  body: { color: colors.text, fontSize: type.body },
  hint: { color: colors.secondary, fontSize: type.secondary },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  label: { color: colors.text, fontSize: type.secondary, fontWeight: "600", marginTop: space.scale },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.scale,
    color: colors.text,
    fontSize: type.body,
    backgroundColor: "#FFFFFF",
  },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    padding: space.scale,
    backgroundColor: "#FFFFFF",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.scale },
  chip: {
    minHeight: 44,
    paddingHorizontal: space.scale,
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
    justifyContent: "center",
  },
  chipOn: { backgroundColor: colors.navy },
  chipLabel: { color: colors.navy, fontSize: type.secondary },
  chipOnLabel: { color: "#FFFFFF", fontSize: type.secondary, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.scale, marginTop: space.scale },
  tiny: { minHeight: 44, justifyContent: "center" },
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
