import { US_STATES, US_TIMEZONES, deviceTimeZone, isValidIanaTimeZone } from "@job-to-invoice/schemas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { copy } from "../../src/i18n/en.ts";
import { useAuth } from "../../src/session/AuthProvider.tsx";
import { secureKv } from "../../src/session/supabase.ts";
import { clearSetupDraft, loadSetupDraft, saveSetupDraft } from "../../src/setup/draft.ts";
import { emptySetupForm, firstFieldError, setupRequestFromForm, type SetupFormValues } from "../../src/setup/form.ts";
import { createSetupIdempotencyKey, retainOrCreateSetupIdempotencyKey } from "../../src/setup/idempotency.ts";
import { colors, space, type } from "../../src/theme.ts";

const STEP1 = new Set(["business_name", "legal_name", "trade", "skip_logo"]);
const STEP2 = new Set([
  "contact_name",
  "contact_email",
  "contact_phone",
  "address",
  "address.line1",
  "address.line2",
  "address.city",
  "address.state",
  "address.postal_code",
]);

function suggestedTimezone(): string {
  const device = deviceTimeZone();
  if (device && isValidIanaTimeZone(device)) {
    return device;
  }
  return "America/New_York";
}

function timezoneChoices(current: string): string[] {
  const list: string[] = [...US_TIMEZONES];
  if (current && !list.includes(current)) {
    list.unshift(current);
  }
  return list;
}

export default function SetupScreen() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const email = auth.bootstrap?.user.display_email ?? auth.snapshot.emailDisplay ?? "";
  const workspaceId = auth.bootstrap?.workspace.id ?? "";
  const setupCompleted = auth.bootstrap?.workspace.setup_completed === true;
  const workspaceVersion = auth.bootstrap?.workspace.version ?? 1;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [values, setValues] = useState<SetupFormValues>(() => emptySetupForm(email, suggestedTimezone()));
  const [timezoneConfirmed, setTimezoneConfirmed] = useState(false);
  const [taxZeroConfirmed, setTaxZeroConfirmed] = useState(false);
  const [skipLogo, setSkipLogo] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [restored, setRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const idempotencyKey = useRef<string | undefined>(undefined);
  idempotencyKey.current = retainOrCreateSetupIdempotencyKey(idempotencyKey.current);
  const inputs = useRef<Record<string, TextInput | null>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!workspaceId) {
        setHydrated(true);
        return;
      }
      const draft = await loadSetupDraft(secureKv, workspaceId, setupCompleted);
      if (cancelled) {
        return;
      }
      if (draft) {
        setValues({ ...draft.values, contact_email: draft.values.contact_email || email });
        setStep(draft.step);
        setTimezoneConfirmed(draft.timezone_confirmed);
        setTaxZeroConfirmed(draft.tax_zero_confirmed);
        setSkipLogo(draft.skip_logo);
        setRestored(true);
        setBanner(copy.setupRestored);
      } else {
        setValues((current) => ({
          ...current,
          contact_email: current.contact_email || email,
          timezone: current.timezone || suggestedTimezone(),
        }));
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [email, setupCompleted, workspaceId]);

  useEffect(() => {
    if (!hydrated || !workspaceId || setupCompleted) {
      return;
    }
    void saveSetupDraft(secureKv, {
      schema_version: 1,
      workspace_id: workspaceId,
      saved_at: new Date().toISOString(),
      step,
      timezone_confirmed: timezoneConfirmed,
      tax_zero_confirmed: taxZeroConfirmed,
      skip_logo: skipLogo,
      values,
    });
  }, [hydrated, setupCompleted, skipLogo, step, taxZeroConfirmed, timezoneConfirmed, values, workspaceId]);

  const setField = useCallback(<K extends keyof SetupFormValues>(key: K, value: SetupFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const parsed = useMemo(
    () => setupRequestFromForm(values, { timezoneConfirmed, taxZeroConfirmed, skipLogo }),
    [skipLogo, taxZeroConfirmed, timezoneConfirmed, values],
  );

  function errorsForStep(current: 1 | 2 | 3): Record<string, string> {
    if (parsed.ok) {
      return {};
    }
    const next: Record<string, string> = {};
    for (const item of parsed.field_errors) {
      const inStep =
        current === 1 ? STEP1.has(item.field) : current === 2 ? STEP2.has(item.field) : !STEP1.has(item.field) && !STEP2.has(item.field);
      if (inStep) {
        next[item.field] = item.message;
      }
    }
    return next;
  }

  function focusField(field?: string) {
    const mapped =
      field === "address.line1"
        ? "line1"
        : field === "address.city"
          ? "city"
          : field === "address.state"
            ? "state"
            : field === "address.postal_code"
              ? "postal_code"
              : field === "default_tax_bp"
                ? "tax_percent"
                : field === "default_due_days"
                  ? "custom_due_days"
                  : field;
    if (mapped && inputs.current[mapped]) {
      inputs.current[mapped]?.focus();
    }
  }

  function goNext() {
    const nextErrors = errorsForStep(step);
    setErrors(nextErrors);
    setFormError(undefined);
    if (Object.keys(nextErrors).length > 0) {
      focusField(Object.keys(nextErrors)[0]);
      return;
    }
    setStep((current) => (current === 1 ? 2 : 3));
  }

  async function submit() {
    const nextErrors = parsed.ok ? {} : Object.fromEntries(parsed.field_errors.map((item) => [item.field, item.message]));
    setErrors(nextErrors);
    if (!parsed.ok) {
      setFormError(undefined);
      focusField(firstFieldError(parsed.field_errors));
      return;
    }
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setFormError(undefined);
    setBanner(undefined);
    const result = await auth.runOwnerRequest({
      path: "/v1/workspace",
      method: "POST",
      body: parsed.value,
      idempotencyKey: idempotencyKey.current,
      ifMatch: workspaceVersion,
    });
    setSubmitting(false);
    if (result.ok) {
      await clearSetupDraft(secureKv);
      setBanner(copy.setupSaved);
      await auth.refreshBootstrap();
      return;
    }
    if (result.error.field_errors && result.error.field_errors.length > 0) {
      const mapped = Object.fromEntries(result.error.field_errors.map((item) => [item.field, item.message]));
      setErrors(mapped);
      focusField(result.error.field_errors[0]?.field);
      return;
    }
    if (result.error.code === "VERSION_CONFLICT") {
      setFormError(copy.setupConflict);
      await auth.refreshBootstrap();
      idempotencyKey.current = createSetupIdempotencyKey();
      return;
    }
    if (result.error.status === 401) {
      setFormError(copy.setupExpired);
      return;
    }
    if (result.error.retryable || result.error.status === 0) {
      setFormError(copy.setupOffline);
      return;
    }
    setFormError(copy.setupGenericError);
  }

  function fieldError(id: string): string | undefined {
    return errors[id];
  }

  const zones = timezoneChoices(values.timezone);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.flex, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <Text accessibilityRole="header" style={styles.title}>
          {copy.setupTitle}
        </Text>
        <Text style={styles.body}>
          {step === 1 ? copy.setupStep1 : step === 2 ? copy.setupStep2 : copy.setupStep3}
        </Text>
        {restored ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.setupRestored}
          </Text>
        ) : null}
        {banner && banner !== copy.setupRestored ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {banner}
          </Text>
        ) : null}
        {formError ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error}>
            {formError}
          </Text>
        ) : null}

        {step === 1 ? (
          <>
            <Field
              error={fieldError("business_name")}
              label={copy.businessName}
              onChange={setField}
              name="business_name"
              required
              register={inputs}
              value={values.business_name}
            />
            <Field
              error={fieldError("legal_name")}
              label={copy.legalName}
              name="legal_name"
              onChange={setField}
              register={inputs}
              required
              value={values.legal_name}
            />
            <Text nativeID="trade-label" style={styles.label}>
              {copy.tradeLabel} ({copy.setupRequired})
            </Text>
            <View accessibilityRole="radiogroup" style={styles.row}>
              <Choice selected={values.trade === "handyman"} label={copy.tradeHandyman} onPress={() => setField("trade", "handyman")} />
              <Choice selected={values.trade === "other"} label={copy.tradeOther} onPress={() => setField("trade", "other")} />
            </View>
            {fieldError("trade") ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError("trade")}
              </Text>
            ) : null}
            <Check
              label={copy.skipLogo}
              hint={copy.skipLogoHint}
              selected={skipLogo}
              onPress={() => setSkipLogo((current) => !current)}
            />
            {fieldError("skip_logo") ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError("skip_logo")}
              </Text>
            ) : null}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Field
              error={fieldError("contact_name")}
              label={copy.contactName}
              name="contact_name"
              onChange={setField}
              register={inputs}
              required
              value={values.contact_name}
            />
            <Field
              autoCapitalize="none"
              error={fieldError("contact_email")}
              keyboardType="email-address"
              label={copy.contactEmail}
              name="contact_email"
              onChange={setField}
              register={inputs}
              required
              textContentType="emailAddress"
              value={values.contact_email}
            />
            <Field
              error={fieldError("contact_phone")}
              keyboardType="phone-pad"
              label={copy.contactPhone}
              name="contact_phone"
              onChange={setField}
              register={inputs}
              textContentType="telephoneNumber"
              value={values.contact_phone}
            />
            <Field
              error={fieldError("address.line1")}
              label={copy.addressLine1}
              name="line1"
              onChange={setField}
              register={inputs}
              required
              textContentType="streetAddressLine1"
              value={values.line1}
            />
            <Field
              error={fieldError("address.line2")}
              label={copy.addressLine2}
              name="line2"
              onChange={setField}
              register={inputs}
              textContentType="streetAddressLine2"
              value={values.line2}
            />
            <Field
              error={fieldError("address.city")}
              label={copy.city}
              name="city"
              onChange={setField}
              register={inputs}
              required
              textContentType="addressCity"
              value={values.city}
            />
            <Text nativeID="state-label" style={styles.label}>
              {copy.state} ({copy.setupRequired})
            </Text>
            <View accessibilityLabel={copy.state} style={styles.wrap}>
              {US_STATES.map((code) => (
                <Choice
                  key={code}
                  compact
                  label={code}
                  onPress={() => setField("state", code)}
                  selected={values.state === code}
                />
              ))}
            </View>
            {fieldError("address.state") ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError("address.state")}
              </Text>
            ) : null}
            <Field
              error={fieldError("address.postal_code")}
              keyboardType="number-pad"
              label={copy.zip}
              name="postal_code"
              onChange={setField}
              register={inputs}
              required
              textContentType="postalCode"
              value={values.postal_code}
            />
          </>
        ) : null}

        {step === 3 ? (
          <>
            <Text nativeID="timezone-label" style={styles.label}>
              {copy.timezone} ({copy.setupRequired})
            </Text>
            <View accessibilityRole="radiogroup">
              {zones.map((zone) => (
                <Choice
                  key={zone}
                  label={zone}
                  onPress={() => {
                    setField("timezone", zone);
                    setTimezoneConfirmed(false);
                  }}
                  selected={values.timezone === zone}
                />
              ))}
            </View>
            <Check
              label={copy.timezoneConfirm}
              selected={timezoneConfirmed}
              onPress={() => setTimezoneConfirmed((current) => !current)}
            />
            {fieldError("timezone") || fieldError("timezone_confirmed") ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError("timezone_confirmed") ?? fieldError("timezone")}
              </Text>
            ) : null}
            <Text style={styles.body}>{copy.currencyLocked}</Text>
            <Field
              error={fieldError("default_tax_bp")}
              keyboardType="decimal-pad"
              label={copy.taxRate}
              name="tax_percent"
              onChange={setField}
              register={inputs}
              required
              value={values.tax_percent}
            />
            <Check
              label={copy.taxConfirm}
              selected={taxZeroConfirmed}
              onPress={() => setTaxZeroConfirmed((current) => !current)}
            />
            {fieldError("tax_zero_confirmed") ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError("tax_zero_confirmed")}
              </Text>
            ) : null}
            <Text style={styles.label}>
              {copy.dueDays} ({copy.setupRequired})
            </Text>
            <View style={styles.wrap}>
              {(["0", "7", "14", "30", "custom"] as const).map((option) => (
                <Choice
                  key={option}
                  compact
                  label={option === "0" ? copy.dueOnReceipt : option === "custom" ? copy.dueCustom : option}
                  onPress={() => setField("due_preset", option)}
                  selected={values.due_preset === option}
                />
              ))}
            </View>
            {values.due_preset === "custom" ? (
              <Field
                error={fieldError("default_due_days")}
                keyboardType="number-pad"
                label={copy.dueCustom}
                name="custom_due_days"
                onChange={setField}
                register={inputs}
                required
                value={values.custom_due_days}
              />
            ) : fieldError("default_due_days") ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError("default_due_days")}
              </Text>
            ) : null}
            <Field
              error={fieldError("default_terms")}
              label={copy.defaultTerms}
              multiline
              name="default_terms"
              onChange={setField}
              register={inputs}
              value={values.default_terms}
            />
          </>
        ) : null}

        <View style={styles.actions}>
          {step > 1 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setErrors({});
                setStep((current) => (current === 3 ? 2 : 1));
              }}
              style={styles.secondary}
            >
              <Text style={styles.secondaryLabel}>{copy.back}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: submitting, disabled: submitting }}
            disabled={submitting}
            onPress={() => {
              if (step < 3) {
                goNext();
              } else {
                void submit();
              }
            }}
            style={[styles.button, submitting ? styles.buttonDisabled : null]}
          >
            <Text style={styles.buttonLabel}>
              {step < 3 ? copy.continue : submitting ? copy.savingSetup : copy.saveSetup}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void auth.signOut("confirm");
            }}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>{copy.signOut}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: {
  name: keyof SetupFormValues | string;
  label: string;
  value: string;
  onChange: <K extends keyof SetupFormValues>(key: K, value: SetupFormValues[K]) => void;
  register: { current: Record<string, TextInput | null> };
  error?: string;
  required?: boolean;
  keyboardType?: TextInput["props"]["keyboardType"];
  autoCapitalize?: TextInput["props"]["autoCapitalize"];
  textContentType?: TextInput["props"]["textContentType"];
  multiline?: boolean;
}) {
  const labelId = `${props.name}-label`;
  const errorId = `${props.name}-error`;
  return (
    <View>
      <Text nativeID={labelId} style={styles.label}>
        {props.label}
        {props.required ? ` (${copy.setupRequired})` : ""}
      </Text>
      <TextInput
        accessibilityLabel={`${props.label}${props.required ? `, ${copy.setupRequired}` : ""}`}
        accessibilityHint={props.error}
        accessibilityLabelledBy={labelId}
        autoCapitalize={props.autoCapitalize}
        keyboardType={props.keyboardType}
        multiline={props.multiline}
        nativeID={props.name}
        onChangeText={(text) => props.onChange(props.name as keyof SetupFormValues, text)}
        ref={(node) => {
          props.register.current[props.name] = node;
        }}
        style={[styles.input, props.multiline ? styles.multiline : null, props.error ? styles.inputError : null]}
        textContentType={props.textContentType}
        value={props.value}
      />
      {props.error ? (
        <Text accessibilityLiveRegion="polite" nativeID={errorId} style={styles.error}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

function Choice(props: { label: string; selected: boolean; onPress: () => void; compact?: boolean }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[styles.choice, props.compact ? styles.choiceCompact : null, props.selected ? styles.choiceSelected : null]}
    >
      <Text style={[styles.choiceLabel, props.selected ? styles.choiceLabelSelected : null]}>{props.label}</Text>
    </Pressable>
  );
}

function Check(props: { label: string; selected: boolean; onPress: () => void; hint?: string }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.selected }}
      accessibilityHint={props.hint}
      onPress={props.onPress}
      style={styles.check}
    >
      <Text style={styles.choiceLabel}>
        {props.selected ? "☑ " : "☐ "}
        {props.label}
      </Text>
      {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.text, fontSize: type.body },
  label: { color: colors.text, fontSize: type.secondary, marginTop: space.scale },
  hint: { color: colors.secondary, fontSize: type.secondary, marginTop: 4 },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: "#FFFFFF",
  },
  multiline: { minHeight: 96, textAlignVertical: "top", paddingVertical: space.scale },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.scale },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: 44,
    minWidth: 44,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    justifyContent: "center",
    marginTop: 4,
  },
  choiceCompact: { paddingHorizontal: 10 },
  choiceSelected: { backgroundColor: colors.navy },
  choiceLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  choiceLabelSelected: { color: "#FFFFFF" },
  check: { minHeight: 44, justifyContent: "center", marginTop: space.scale },
  actions: { gap: space.scale, marginTop: space.gutter },
  button: {
    minHeight: 48,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "600" },
  secondary: {
    minHeight: 48,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});
