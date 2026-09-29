import { US_STATES } from "@job-to-invoice/schemas";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
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
  customerCreateFromForm,
  customerMutationDenied,
  emptyCustomerForm,
  firstCustomerFieldError,
  type CustomerFormValues,
} from "../../../src/customers/form.ts";
import {
  CUSTOMER_TARGET_MIN_PT,
  customerSubmitBlocked,
  presentCreateAnyway,
  presentCreateCustomerDestination,
  presentDuplicateConfirmation,
  type CustomerDuplicate,
} from "../../../src/customers/presentation.ts";
import { copy } from "../../../src/i18n/en.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, type } from "../../../src/theme.ts";

const PRIMARY = "#464B71";
const FIELD_BORDER = "#D5DCE3";
const PLACEHOLDER = "#52606D";

export default function NewCustomerScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ returnTo?: string | string[]; relatedJobId?: string | string[] }>();
  const returnTo = firstParam(params.returnTo);
  const relatedJobId = firstParam(params.relatedJobId);
  const [values, setValues] = useState<CustomerFormValues>(emptyCustomerForm());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [retryable, setRetryable] = useState(false);
  const [duplicates, setDuplicates] = useState<CustomerDuplicate[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [focused, setFocused] = useState<string | undefined>();
  const idempotencyKey = useRef<string | undefined>(undefined);
  idempotencyKey.current = retainOrCreateSetupIdempotencyKey(idempotencyKey.current);
  const customerId = useRef(secureRandomUUID());
  const inputs = useRef<Record<string, TextInput | null>>({});
  const duplicate = presentDuplicateConfirmation(duplicates, values.email);

  function setField<K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function goBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/customers");
  }

  function finish(customerIdValue: string, customerName: string) {
    const destination = presentCreateCustomerDestination({
      returnTo,
      relatedJobId,
      customerId: customerIdValue,
      customerName,
    });
    if ("params" in destination) {
      router.replace({ pathname: destination.pathname, params: destination.params });
      return;
    }
    router.replace(destination.pathname);
  }

  async function submit(confirmDuplicate = false) {
    if (customerSubmitBlocked(submitting)) {
      return;
    }
    if (auth.snapshot.status === "access_expired") {
      setFormError(copy.accessExpired);
      setRetryable(false);
      return;
    }
    if (customerMutationDenied(auth.snapshot.status)) {
      setFormError(copy.customersOffline);
      setRetryable(false);
      return;
    }
    const nextValues = { ...values, confirm_duplicate_email: confirmDuplicate };
    const parsed = customerCreateFromForm(nextValues, customerId.current);
    if (!parsed.ok) {
      const next: Record<string, string> = {};
      for (const item of parsed.field_errors) next[item.field] = item.message;
      setErrors(next);
      setFormError(undefined);
      setRetryable(false);
      const focus = firstCustomerFieldError(next);
      const focusName = focus === "billing_address" ? "line1" : focus?.replace("billing_address.", "");
      if (focusName) inputs.current[focusName]?.focus();
      return;
    }
    if (confirmDuplicate) {
      idempotencyKey.current = secureRandomUUID();
    }
    setSubmitting(true);
    setFormError(undefined);
    setRetryable(false);
    const result = await auth.runOwnerRequest<{ id: string; name: string }>({
      path: "/v1/customers",
      method: "POST",
      body: bodyWithoutNormalized(parsed.value),
      idempotencyKey: idempotencyKey.current,
    });
    setSubmitting(false);
    if (!result.ok) {
      if (result.error.code === "DUPLICATE_CUSTOMER_EMAIL") {
        setDuplicates(result.error.duplicates ?? []);
        setValues((current) => ({ ...current, confirm_duplicate_email: false }));
        if (!result.error.duplicates?.length) {
          setFormError(result.error.message);
        }
        return;
      }
      if (result.error.code === "IDEMPOTENCY_MISMATCH") {
        idempotencyKey.current = secureRandomUUID();
      }
      const fieldErrors: Record<string, string> = {};
      for (const item of result.error.field_errors ?? []) fieldErrors[item.field] = item.message;
      setErrors(fieldErrors);
      setRetryable(result.error.retryable);
      setFormError(
        result.error.status === 401 || result.error.code === "UNAUTHENTICATED"
          ? copy.accessExpired
          : result.error.message || copy.customersLoadError,
      );
      return;
    }
    setDuplicates([]);
    finish(result.data.id, result.data.name);
  }

  async function useExisting() {
    if (!duplicate || customerSubmitBlocked(submitting)) {
      return;
    }
    if (customerMutationDenied(auth.snapshot.status)) {
      setFormError(copy.customersOffline);
      return;
    }
    if (duplicate.archived) {
      setSubmitting(true);
      const result = await auth.runOwnerRequest({
        path: `/v1/customers/${duplicate.id}/archive`,
        method: "POST",
        body: { archived: false },
        idempotencyKey: secureRandomUUID(),
      });
      setSubmitting(false);
      if (!result.ok) {
        setFormError(result.error.message);
        setRetryable(result.error.retryable);
        return;
      }
    }
    setDuplicates([]);
    finish(duplicate.id, duplicate.name);
  }

  const offline = customerMutationDenied(auth.snapshot.status);

  return (
    <View style={styles.root}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleRow}>
            <Pressable accessibilityLabel={copy.back} accessibilityRole="button" hitSlop={4} onPress={goBack} style={styles.backHit}>
              <View style={styles.backCircle}>
                <View style={styles.backChevron}>
                  <View style={styles.backChevronTop} />
                  <View style={styles.backChevronBottom} />
                </View>
              </View>
            </Pressable>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.createCustomer}
            </Text>
          </View>
          <Text style={styles.support}>{copy.createCustomerSupport}</Text>
          {offline ? (
            <Text accessibilityLiveRegion="polite" style={styles.notice}>
              {copy.customersOffline}
            </Text>
          ) : null}
          {formError ? (
            <Text accessibilityLiveRegion="assertive" style={styles.error}>
              {formError}
            </Text>
          ) : null}
          {retryable ? (
            <Pressable accessibilityRole="button" onPress={() => void submit(false)} style={styles.retry}>
              <Text style={styles.retryLabel}>{copy.customerPickerRetry}</Text>
            </Pressable>
          ) : null}

          <Text style={styles.section}>{copy.customerDetails}</Text>
          <Field
            autoCapitalize="words"
            error={errors.name}
            focused={focused === "name"}
            label={copy.customerName}
            name="name"
            onChange={(value) => setField("name", value)}
            onFocus={setFocused}
            placeholder={copy.customerNamePlaceholder}
            register={inputs}
            textContentType="name"
            value={values.name}
          />
          <Field
            autoCapitalize="none"
            autoComplete="email"
            error={errors.email}
            focused={focused === "email"}
            keyboardType="email-address"
            label={copy.customerEmailRequired}
            name="email"
            onChange={(value) => setField("email", value)}
            onFocus={setFocused}
            placeholder={copy.customerEmailPlaceholder}
            register={inputs}
            textContentType="emailAddress"
            value={values.email}
          />
          <Field
            autoComplete="tel"
            error={errors.phone}
            focused={focused === "phone"}
            keyboardType="phone-pad"
            label={copy.customerPhoneNumber}
            name="phone"
            onChange={(value) => setField("phone", value)}
            onFocus={setFocused}
            placeholder={copy.customerPhonePlaceholder}
            register={inputs}
            textContentType="telephoneNumber"
            value={values.phone}
          />
          <Field
            autoComplete="address-line1"
            error={errors["billing_address.line1"] ?? errors.billing_address}
            focused={focused === "line1"}
            label={copy.addressLine1}
            name="line1"
            onChange={(value) => setField("line1", value)}
            onFocus={setFocused}
            placeholder={copy.addressLine1Placeholder}
            register={inputs}
            textContentType="streetAddressLine1"
            value={values.line1}
          />
          <Field
            autoComplete="address-line2"
            error={errors["billing_address.line2"]}
            focused={focused === "line2"}
            label={copy.addressLine2}
            name="line2"
            onChange={(value) => setField("line2", value)}
            onFocus={setFocused}
            placeholder={copy.addressLine2Placeholder}
            register={inputs}
            textContentType="streetAddressLine2"
            value={values.line2}
          />
          <View style={styles.split}>
            <View style={styles.splitItem}>
              <Field
                autoComplete="postal-address-locality"
                error={errors["billing_address.city"]}
                focused={focused === "city"}
                label={copy.city}
                name="city"
                onChange={(value) => setField("city", value)}
                onFocus={setFocused}
                placeholder={copy.cityPlaceholder}
                register={inputs}
                textContentType="addressCity"
                value={values.city}
              />
            </View>
            <View style={styles.splitItem}>
              <Text style={styles.label}>{copy.state}</Text>
              <Pressable
                accessibilityLabel={`${copy.state}, ${values.state || copy.statePlaceholder}`}
                accessibilityRole="button"
                onPress={() => setStateOpen(true)}
                style={[styles.input, styles.stateField, errors["billing_address.state"] ? styles.inputError : null]}
              >
                <Text style={values.state ? styles.stateValue : styles.placeholder}>{values.state || copy.statePlaceholder}</Text>
                <Text style={styles.stateChevron}>▾</Text>
              </Pressable>
              {errors["billing_address.state"] ? (
                <Text accessibilityLiveRegion="polite" style={styles.error}>
                  {errors["billing_address.state"]}
                </Text>
              ) : null}
            </View>
          </View>
          <Field
            autoComplete="postal-code"
            error={errors["billing_address.postal_code"]}
            focused={focused === "postal_code"}
            keyboardType="number-pad"
            label={copy.customerPostalCode}
            name="postal_code"
            onChange={(value) => setField("postal_code", value)}
            onFocus={setFocused}
            placeholder={copy.customerPostalPlaceholder}
            register={inputs}
            textContentType="postalCode"
            value={values.postal_code}
          />
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <Pressable
            accessibilityLabel={submitting ? copy.customerSaving : copy.saveCustomer}
            accessibilityRole="button"
            accessibilityState={{ busy: submitting, disabled: submitting || offline }}
            disabled={submitting || offline}
            onPress={() => void submit(false)}
            style={[styles.primary, submitting || offline ? styles.primaryDisabled : null]}
          >
            <Text style={styles.primaryLabel}>{submitting ? copy.customerSaving : copy.saveCustomer}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <Modal animationType="fade" onRequestClose={() => setStateOpen(false)} transparent visible={stateOpen}>
        <View style={styles.sheetBackdrop}>
          <Pressable accessibilityLabel={copy.customerPickerClose} onPress={() => setStateOpen(false)} style={styles.dismiss} />
          <View style={[styles.stateSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.state}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              {US_STATES.map((code) => {
                const selected = values.state === code;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    key={code}
                    onPress={() => {
                      setField("state", code);
                      setStateOpen(false);
                    }}
                    style={[styles.stateRow, selected ? styles.stateRowSelected : null]}
                  >
                    <Text style={styles.stateRowLabel}>{code}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        accessibilityViewIsModal
        animationType="fade"
        onRequestClose={() => setDuplicates([])}
        transparent
        visible={duplicate !== null}
      >
        <View style={styles.sheetBackdrop}>
          <Pressable accessibilityLabel={copy.customerDuplicateClose} onPress={() => setDuplicates([])} style={styles.dismiss} />
          {duplicate ? (
            <View style={[styles.duplicateSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <View style={styles.handle} />
              <View style={styles.duplicateHeading}>
                <View style={styles.personBadge}>
                  <View style={styles.personHead} />
                  <View style={styles.personShoulders} />
                </View>
                <Text accessibilityRole="header" style={styles.duplicateTitle}>
                  {copy.customerDuplicateTitle}
                </Text>
              </View>
              <Text accessibilityLiveRegion="polite" style={styles.duplicateBody}>
                {copy.customerDuplicateBody}
              </Text>
              <View style={styles.existingCard}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarLabel}>{duplicate.initials}</Text>
                </View>
                <View style={styles.existingCopy}>
                  <Text style={styles.existingName}>{duplicate.name}</Text>
                  <Text style={styles.existingEmail}>{duplicate.email}</Text>
                </View>
              </View>
              <Pressable
                accessibilityLabel={copy.customerUseExisting}
                accessibilityRole="button"
                accessibilityState={{ disabled: submitting, busy: submitting }}
                disabled={submitting}
                onPress={() => void useExisting()}
                style={styles.useExisting}
              >
                <Text style={styles.useExistingLabel}>{copy.customerUseExisting}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={copy.customerCreateAnyway}
                accessibilityRole="button"
                accessibilityState={{ disabled: submitting, busy: submitting }}
                disabled={submitting}
                onPress={() => {
                  setValues((current) => ({ ...current, ...presentCreateAnyway() }));
                  void submit(true);
                }}
                style={styles.createAnyway}
              >
                <Text style={styles.createAnywayLabel}>{copy.customerCreateAnyway}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

function bodyWithoutNormalized(value: {
  id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: unknown;
  confirm_duplicate_email: boolean;
}) {
  const body: Record<string, unknown> = { name: value.name };
  if (value.id) body.id = value.id;
  if (value.email) body.email = value.email;
  if (value.phone) body.phone = value.phone;
  if (value.billing_address) body.billing_address = value.billing_address;
  if (value.confirm_duplicate_email) body.confirm_duplicate_email = true;
  return body;
}

function firstParam(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

function Field(props: {
  name: string;
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  focused: boolean;
  onChange: (value: string) => void;
  onFocus: (name: string | undefined) => void;
  register: { current: Record<string, TextInput | null> };
  keyboardType?: TextInput["props"]["keyboardType"];
  autoCapitalize?: TextInput["props"]["autoCapitalize"];
  autoComplete?: TextInput["props"]["autoComplete"];
  textContentType?: TextInput["props"]["textContentType"];
}) {
  return (
    <View style={styles.field}>
      <Text nativeID={`${props.name}-label`} style={styles.label}>
        {props.label}
      </Text>
      <TextInput
        accessibilityHint={props.error}
        accessibilityLabel={props.label}
        accessibilityLabelledBy={`${props.name}-label`}
        autoCapitalize={props.autoCapitalize}
        autoComplete={props.autoComplete}
        keyboardType={props.keyboardType}
        nativeID={props.name}
        onBlur={() => props.onFocus(undefined)}
        onChangeText={props.onChange}
        onFocus={() => props.onFocus(props.name)}
        placeholder={props.placeholder}
        placeholderTextColor={PLACEHOLDER}
        ref={(node) => {
          props.register.current[props.name] = node;
        }}
        style={[styles.input, props.focused ? styles.inputFocused : null, props.error ? styles.inputError : null]}
        textContentType={props.textContentType}
        value={props.value}
      />
      {props.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  atmosphere: {
    position: "absolute",
    width: 300,
    height: 270,
    borderRadius: 150,
    backgroundColor: "#E4EAF6",
    top: -100,
    right: -70,
  },
  content: { paddingHorizontal: 20, paddingBottom: 24, gap: 7 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 },
  backHit: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  backCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: FIELD_BORDER,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  backChevron: { width: 10, height: 16, marginLeft: -2 },
  backChevronTop: {
    position: "absolute",
    top: 2,
    width: 10,
    height: 2,
    backgroundColor: colors.text,
    transform: [{ rotate: "-45deg" }],
    borderRadius: 1,
  },
  backChevronBottom: {
    position: "absolute",
    bottom: 2,
    width: 10,
    height: 2,
    backgroundColor: colors.text,
    transform: [{ rotate: "45deg" }],
    borderRadius: 1,
  },
  title: { flex: 1, color: colors.text, fontSize: 26, lineHeight: 33, fontWeight: "700" },
  support: { color: colors.secondary, fontSize: 13, lineHeight: 19, marginBottom: 8 },
  section: { color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: "600", marginTop: 4 },
  notice: { color: colors.navy, fontSize: 13, lineHeight: 19 },
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 12, lineHeight: 17, fontWeight: "500" },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: FIELD_BORDER,
    borderRadius: 15,
    paddingHorizontal: 15,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputFocused: { borderColor: PRIMARY },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  placeholder: { color: PLACEHOLDER, fontSize: 14, flex: 1 },
  split: { flexDirection: "row", gap: 10 },
  splitItem: { flex: 1 },
  stateField: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: Math.max(46, CUSTOMER_TARGET_MIN_PT) },
  stateValue: { color: colors.text, fontSize: 14, flex: 1 },
  stateChevron: { color: PLACEHOLDER, fontSize: 14, marginLeft: 6 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 18 },
  retry: { minHeight: CUSTOMER_TARGET_MIN_PT, justifyContent: "center" },
  retryLabel: { color: PRIMARY, fontSize: type.body, fontWeight: "600" },
  footer: { paddingHorizontal: 20, paddingTop: 16, backgroundColor: colors.surface },
  primary: {
    minHeight: 56,
    backgroundColor: PRIMARY,
    borderRadius: 16,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryDisabled: { opacity: 0.45 },
  primaryLabel: { color: colors.surface, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(18,30,43,0.38)", justifyContent: "flex-end" },
  dismiss: { flex: 1 },
  stateSheet: {
    maxHeight: "70%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 8,
  },
  sheetTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  stateRow: { minHeight: CUSTOMER_TARGET_MIN_PT, justifyContent: "center", paddingHorizontal: 8 },
  stateRowSelected: { backgroundColor: "#F3F6FA", borderRadius: 12 },
  stateRowLabel: { color: colors.text, fontSize: type.body, fontWeight: "600" },
  duplicateSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 12,
  },
  handle: { alignSelf: "center", width: 42, height: 5, borderRadius: 3, backgroundColor: "#C2CBD4", marginBottom: 4 },
  duplicateHeading: { flexDirection: "row", alignItems: "flex-start", gap: 16 },
  personBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#E8EEF4",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  personHead: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: PRIMARY,
    marginBottom: 2,
  },
  personShoulders: {
    width: 18,
    height: 9,
    borderWidth: 1.5,
    borderColor: PRIMARY,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
    borderBottomWidth: 0,
  },
  duplicateTitle: { flex: 1, color: colors.text, fontSize: 20, lineHeight: 26, fontWeight: "700", paddingTop: 2 },
  duplicateBody: { color: colors.secondary, fontSize: 13, lineHeight: 19 },
  existingCard: {
    minHeight: 76,
    borderWidth: 1,
    borderColor: FIELD_BORDER,
    borderRadius: 16,
    backgroundColor: colors.background,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#E8EEF4",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLabel: { color: PRIMARY, fontSize: 13, fontWeight: "600" },
  existingCopy: { flex: 1, gap: 2 },
  existingName: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  existingEmail: { color: colors.secondary, fontSize: 12, lineHeight: 17 },
  useExisting: {
    minHeight: 52,
    backgroundColor: PRIMARY,
    borderRadius: 16,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  useExistingLabel: { color: colors.surface, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  createAnyway: {
    minHeight: CUSTOMER_TARGET_MIN_PT,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: FIELD_BORDER,
    borderRadius: 16,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  createAnywayLabel: { color: PRIMARY, fontSize: 13, lineHeight: 18, fontWeight: "600" },
});
