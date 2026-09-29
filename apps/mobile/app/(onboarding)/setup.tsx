import { deviceTimeZone, suggestedBusinessTimeZone } from "@job-to-invoice/schemas";
import { useRouter } from "expo-router";
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
import { TimezonePicker } from "../../src/setup/TimezonePicker.tsx";
import { emptySetupForm, firstFieldError, setupRequestFromForm, type SetupFormValues } from "../../src/setup/form.ts";
import { createSetupIdempotencyKey, retainOrCreateSetupIdempotencyKey } from "../../src/setup/idempotency.ts";
import {
  SETUP_GUTTER,
  SETUP_HIT_TARGET,
  SETUP_PRIMARY_BUTTON_MIN_HEIGHT,
  SETUP_PROGRESS_ACCENT,
  presentBasicInfoScreen,
  presentContinueLabel,
  presentDefaultsScreen,
  presentDuePresetLabel,
  presentEmailAccessibility,
  presentFieldAccessibility,
  presentFirstInvalidField,
  presentNextInputName,
  presentSavingAnnouncement,
  presentSetupFieldErrors,
  presentSetupProgress,
  presentTimezoneFieldValue,
} from "../../src/setup/presentation.ts";
import { APP_JOBS_HREF } from "../../src/session/logic.ts";
import { colors, space, type } from "../../src/theme.ts";
import { PublicAtmosphere } from "../../src/ui/PublicAtmosphere.tsx";

function suggestedTimezone(): string {
  return suggestedBusinessTimeZone();
}

export default function SetupScreen() {
  const auth = useAuth();
  const router = useRouter();
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
  const [timezonePickerOpen, setTimezonePickerOpen] = useState(false);
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
    if (!email) {
      return;
    }
    setValues((current) => (current.contact_email === email ? current : { ...current, contact_email: email }));
  }, [email]);

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
    return presentSetupFieldErrors(values, { timezoneConfirmed, taxZeroConfirmed, skipLogo }, current);
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
      focusField(presentFirstInvalidField(values, { timezoneConfirmed, taxZeroConfirmed, skipLogo }, step));
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
      router.replace(APP_JOBS_HREF);
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

  const basic = presentBasicInfoScreen();
  const defaults = presentDefaultsScreen();
  const progress = presentSetupProgress(step);
  const detectedTimezone = deviceTimeZone();
  const continueLabel = presentContinueLabel(step, submitting);
  const savingAnnouncement = presentSavingAnnouncement(submitting);
  const emailA11y = presentEmailAccessibility(copy.contactEmail);

  if (!hydrated) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + SETUP_GUTTER }]}>
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {copy.restoring}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <PublicAtmosphere />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: insets.top + SETUP_GUTTER,
              paddingHorizontal: SETUP_GUTTER,
              paddingBottom: space.gutter,
            },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          {step > 1 ? (
            <Pressable
              accessibilityLabel={copy.back}
              accessibilityRole="button"
              onPress={() => {
                setErrors({});
                setStep((current) => (current === 3 ? 2 : 1));
              }}
              style={styles.backHit}
            >
              <Text style={styles.backLabel}>{copy.back}</Text>
            </Pressable>
          ) : null}
          <Text style={styles.progressMeta}>
            {copy.setupStepOf.replace("{current}", String(step)).replace("{total}", "3")}
            {"  ·  "}
            {progress.section}
            {"  ·  "}
            {progress.percentLabel}
          </Text>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress.fraction * 100)}%` }]} />
          </View>
          <Text accessibilityRole="header" style={styles.title}>
            {step === 1 ? basic.heading : step === 3 ? defaults.heading : copy.setupTitle}
          </Text>
          <Text style={styles.body}>
            {step === 1 ? basic.supportingText : step === 2 ? copy.skipLogoHint : defaults.supportingText}
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
              autoComplete="organization"
              textContentType="organizationName"
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
            <View accessibilityLabel={copy.tradeLabel} accessibilityRole="radiogroup" style={styles.row}>
              <Choice selected={values.trade === "handyman"} label={copy.tradeHandyman} onPress={() => setField("trade", "handyman")} />
              <Choice selected={values.trade === "other"} label={copy.tradeOther} onPress={() => setField("trade", "other")} />
            </View>
            {fieldError("trade") ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {fieldError("trade")}
              </Text>
            ) : null}
            <Field
              error={fieldError("contact_name")}
              label={copy.contactName}
              name="contact_name"
              onChange={setField}
              register={inputs}
              required
              autoComplete="name"
              textContentType="name"
              value={values.contact_name}
            />
            <Field
              autoCapitalize="none"
              editable={false}
              error={fieldError("contact_email")}
              keyboardType="email-address"
              label={`${copy.contactEmail} · ${basic.emailVerifiedLabel}`}
              name="contact_email"
              onChange={setField}
              register={inputs}
              required
              textContentType="emailAddress"
              value={values.contact_email || email}
              accessibilityOverride={emailA11y}
            />
            <Field
              error={fieldError("contact_phone")}
              keyboardType="phone-pad"
              label={copy.contactPhone}
              name="contact_phone"
              onChange={setField}
              register={inputs}
              autoComplete="tel"
              textContentType="telephoneNumber"
              value={values.contact_phone}
            />
            <Text style={styles.section}>{basic.addressSection}</Text>
            <Field
              error={fieldError("address.line1")}
              label={copy.addressLine1}
              name="line1"
              onChange={setField}
              register={inputs}
              required
              autoComplete="street-address"
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
            <Field
              autoCapitalize="characters"
              error={fieldError("address.state")}
              label={copy.state}
              name="state"
              onChange={(_key, value) => setField("state", String(value).replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase())}
              register={inputs}
              required
              textContentType="addressState"
              value={values.state}
            />
            <Field
              error={fieldError("address.postal_code")}
              keyboardType="number-pad"
              label={copy.zip}
              name="postal_code"
              onChange={setField}
              register={inputs}
              required
              autoComplete="postal-code"
              textContentType="postalCode"
              value={values.postal_code}
            />
          </>
        ) : null}

        {step === 2 ? (
          <>
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

        {step === 3 ? (
          <>
            <Text nativeID="timezone-label" style={styles.label}>
              {copy.timezone} ({copy.setupRequired})
            </Text>
            <Pressable
              accessibilityHint={copy.timezonePickerHint}
              accessibilityLabel={`${copy.timezone}, ${presentTimezoneFieldValue(values.timezone)}`}
              accessibilityRole="button"
              onPress={() => setTimezonePickerOpen(true)}
              style={styles.timezoneField}
            >
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.globe} />
              <Text style={styles.timezoneValue}>{presentTimezoneFieldValue(values.timezone)}</Text>
              <Text style={styles.chevron}>▾</Text>
            </Pressable>
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
            <Text nativeID="currency-label" style={styles.label}>
              {defaults.currencyLabel}
            </Text>
            <View
              accessibilityLabel={`${defaults.currencyLabel}, ${defaults.currencyValue}`}
              accessibilityHint={defaults.currencyHint}
              accessibilityState={{ disabled: true }}
              style={styles.currencyField}
            >
              <Text style={styles.currencyValue}>{defaults.currencyValue}</Text>
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.lockWrap}>
                <View style={styles.lockShackle} />
                <View style={styles.lockBody} />
              </View>
            </View>
            <Text style={styles.hint}>{defaults.currencyHint}</Text>
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
            <View accessibilityRole="radiogroup" style={styles.wrap}>
              {(["0", "7", "14", "30", "custom"] as const).map((option) => (
                <Choice
                  key={option}
                  compact
                  label={presentDuePresetLabel(option)}
                  accessibilityLabel={option === "0" ? copy.dueOnReceipt : presentDuePresetLabel(option)}
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
              placeholder={copy.defaultTermsPlaceholder}
              register={inputs}
              value={values.default_terms}
            />
          </>
        ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void auth.signOut("confirm");
            }}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>{copy.signOut}</Text>
          </Pressable>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.gutter), paddingHorizontal: SETUP_GUTTER }]}>
          <Pressable
            accessibilityLabel={continueLabel}
            accessibilityLiveRegion={savingAnnouncement ? "polite" : undefined}
            accessibilityRole="button"
            accessibilityState={{ busy: submitting, disabled: submitting }}
            disabled={submitting}
            onPress={() => {
              if (submitting) {
                return;
              }
              if (step < 3) {
                goNext();
              } else {
                void submit();
              }
            }}
            style={[
              styles.button,
              { minHeight: SETUP_PRIMARY_BUTTON_MIN_HEIGHT },
              submitting ? styles.buttonDisabled : null,
            ]}
          >
            <Text style={styles.buttonLabel}>{continueLabel}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
      <TimezonePicker
        committed={values.timezone}
        device={detectedTimezone}
        onClose={() => setTimezonePickerOpen(false)}
        onConfirm={(zone) => {
          if (zone !== values.timezone) {
            setField("timezone", zone);
            setTimezoneConfirmed(false);
          }
          setTimezonePickerOpen(false);
        }}
        visible={timezonePickerOpen}
      />
    </View>
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
  editable?: boolean;
  keyboardType?: TextInput["props"]["keyboardType"];
  autoCapitalize?: TextInput["props"]["autoCapitalize"];
  textContentType?: TextInput["props"]["textContentType"];
  autoComplete?: TextInput["props"]["autoComplete"];
  placeholder?: string;
  multiline?: boolean;
  accessibilityOverride?: {
    accessibilityLabel: string;
    accessibilityHint?: string;
    editable?: boolean;
    accessibilityState?: { disabled?: boolean };
  };
}) {
  const labelId = `${props.name}-label`;
  const errorId = `${props.name}-error`;
  const a11y = props.accessibilityOverride ?? presentFieldAccessibility(props.label, props.required === true, props.error);
  const next = presentNextInputName(String(props.name));
  const editable = props.accessibilityOverride?.editable ?? props.editable ?? true;
  const labelHasStatus =
    props.label.includes(copy.setupRequired) ||
    props.label.includes(copy.setupOptional) ||
    props.label.includes("(optional)");
  return (
    <View>
      <Text nativeID={labelId} style={styles.label}>
        {props.label}
        {labelHasStatus ? "" : props.required ? ` (${copy.setupRequired})` : ` (${copy.setupOptional})`}
      </Text>
      <TextInput
        accessibilityHint={a11y.accessibilityHint ?? props.error}
        accessibilityLabel={a11y.accessibilityLabel}
        accessibilityLabelledBy={labelId}
        accessibilityState={props.accessibilityOverride?.accessibilityState ?? { disabled: editable === false }}
        autoCapitalize={props.autoCapitalize}
        autoComplete={props.autoComplete}
        blurOnSubmit={!next}
        editable={editable}
        keyboardType={props.keyboardType}
        multiline={props.multiline}
        nativeID={props.name}
        placeholder={props.placeholder}
        placeholderTextColor={colors.secondary}
        onChangeText={(text) => {
          if (editable === false) {
            return;
          }
          props.onChange(props.name as keyof SetupFormValues, text);
        }}
        onSubmitEditing={() => {
          if (next) {
            props.register.current[next]?.focus();
          }
        }}
        ref={(node) => {
          props.register.current[props.name] = node;
        }}
        returnKeyType={next ? "next" : props.multiline ? "default" : "done"}
        style={[
          styles.input,
          props.multiline ? styles.multiline : null,
          props.error ? styles.inputError : null,
          editable === false ? styles.inputReadonly : null,
        ]}
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

function Choice(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
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
  root: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { gap: space.scale, flexGrow: 1 },
  backHit: { minHeight: SETUP_HIT_TARGET, minWidth: SETUP_HIT_TARGET, justifyContent: "center", alignSelf: "flex-start" },
  backLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  progressMeta: { color: colors.navy, fontSize: type.secondary, fontWeight: "700" },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.infoTint,
    overflow: "hidden",
  },
  progressFill: { height: 8, borderRadius: 999, backgroundColor: SETUP_PROGRESS_ACCENT },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.secondary, fontSize: type.body },
  section: { color: colors.text, fontSize: type.section, fontWeight: "700", marginTop: space.scale },
  label: { color: colors.text, fontSize: type.secondary, marginTop: space.scale },
  hint: { color: colors.secondary, fontSize: type.secondary, marginTop: 4 },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: SETUP_HIT_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputReadonly: { backgroundColor: colors.infoTint },
  multiline: { minHeight: 96, textAlignVertical: "top", paddingVertical: space.scale },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.scale },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: SETUP_HIT_TARGET,
    minWidth: SETUP_HIT_TARGET,
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
  choiceLabelSelected: { color: colors.surface },
  check: { minHeight: SETUP_HIT_TARGET, justifyContent: "center", marginTop: space.scale },
  timezoneField: {
    minHeight: SETUP_PRIMARY_BUTTON_MIN_HEIGHT,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    backgroundColor: colors.surface,
    paddingHorizontal: space.gutter,
    flexDirection: "row",
    alignItems: "center",
    gap: space.scale,
  },
  globe: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.navy,
  },
  timezoneValue: { flex: 1, color: colors.text, fontSize: type.body },
  chevron: { color: colors.navy, fontSize: type.body, fontWeight: "700" },
  currencyField: {
    minHeight: SETUP_HIT_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    backgroundColor: colors.infoTint,
    paddingHorizontal: space.gutter,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.scale,
  },
  currencyValue: { color: colors.text, fontSize: type.body, flex: 1 },
  lockWrap: { width: 18, height: 20, alignItems: "center" },
  lockShackle: {
    width: 10,
    height: 7,
    borderWidth: 2,
    borderBottomWidth: 0,
    borderColor: colors.navy,
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
  },
  lockBody: { width: 14, height: 10, backgroundColor: colors.navy, borderRadius: 2, marginTop: -1 },
  footer: {
    paddingTop: space.gutter,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  button: {
    minHeight: SETUP_PRIMARY_BUTTON_MIN_HEIGHT,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.gutter,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: colors.surface, fontSize: type.body, fontWeight: "600", textAlign: "center" },
  secondary: {
    minHeight: SETUP_HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.gutter,
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});
