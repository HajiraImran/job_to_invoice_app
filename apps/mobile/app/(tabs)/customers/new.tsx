import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../src/crypto/uuid.ts";
import { customerCreateFromForm, customerMutationDenied, emptyCustomerForm, type CustomerFormValues } from "../../../src/customers/form.ts";
import { CUSTOMER_PRIMARY_MIN_PT, CUSTOMER_TARGET_MIN_PT, type CustomerDuplicate } from "../../../src/customers/presentation.ts";
import { copy } from "../../../src/i18n/en.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

export default function NewCustomerScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ returnTo?: string }>();
  const [values, setValues] = useState<CustomerFormValues>(emptyCustomerForm());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [duplicates, setDuplicates] = useState<CustomerDuplicate[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string | undefined>(undefined);
  idempotencyKey.current = retainOrCreateSetupIdempotencyKey(idempotencyKey.current);
  const customerId = useRef(secureRandomUUID());

  function setField<K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    if (customerMutationDenied(auth.snapshot.status)) {
      setFormError(copy.customersOffline);
      return;
    }
    const parsed = customerCreateFromForm(values, customerId.current);
    if (!parsed.ok) {
      const next: Record<string, string> = {};
      for (const item of parsed.field_errors) next[item.field] = item.message;
      setErrors(next);
      setFormError(copy.jobCreateError);
      return;
    }
    setSubmitting(true);
    const result = await auth.runOwnerRequest<{ id: string; name: string }>({
      path: "/v1/customers",
      method: "POST",
      body: parsed.value.confirm_duplicate_email
        ? { ...bodyWithoutNormalized(parsed.value), confirm_duplicate_email: true }
        : bodyWithoutNormalized(parsed.value),
      idempotencyKey: idempotencyKey.current,
    });
    setSubmitting(false);
    if (!result.ok) {
      if (result.error.code === "DUPLICATE_CUSTOMER_EMAIL") {
        setDuplicates(result.error.duplicates ?? []);
        setFormError(copy.customerDuplicate);
        setValues((current) => ({ ...current, confirm_duplicate_email: false }));
        return;
      }
      setFormError(result.error.message);
      return;
    }
    if (params.returnTo === "job") {
      router.replace({ pathname: "/jobs/new", params: { customerId: result.data.id, customerName: result.data.name } });
      return;
    }
    router.replace(`/customers/${result.data.id}`);
  }

  async function restore(duplicate: CustomerDuplicate) {
    if (customerMutationDenied(auth.snapshot.status)) {
      setFormError(copy.customersOffline);
      return;
    }
    const result = await auth.runOwnerRequest({
      path: `/v1/customers/${duplicate.id}/archive`,
      method: "POST",
      body: { archived: false },
      idempotencyKey: secureRandomUUID(),
    });
    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }
    router.replace(`/customers/${duplicate.id}`);
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.gutter }]} style={styles.flex}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.createCustomer}
      </Text>
      {submitting ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.customersLoading}
        </Text>
      ) : null}
      {formError ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {formError}
        </Text>
      ) : null}
      <Field error={errors.name} label={copy.customerName} onChangeText={(value) => setField("name", value)} value={values.name} />
      <Field error={errors.email} label={copy.customerEmail} onChangeText={(value) => setField("email", value)} value={values.email} />
      <Field error={errors.phone} label={copy.customerPhone} onChangeText={(value) => setField("phone", value)} value={values.phone} />
      <Text style={styles.label}>{copy.customerBilling}</Text>
      <Field error={errors["billing_address.line1"] ?? errors.billing_address} label={copy.addressLine1} onChangeText={(value) => setField("line1", value)} value={values.line1} />
      <Field label={copy.addressLine2} onChangeText={(value) => setField("line2", value)} value={values.line2} />
      <Field error={errors["billing_address.city"]} label={copy.city} onChangeText={(value) => setField("city", value)} value={values.city} />
      <Field error={errors["billing_address.state"]} label={copy.state} onChangeText={(value) => setField("state", value)} value={values.state} />
      <Field error={errors["billing_address.postal_code"]} label={copy.postalCode} onChangeText={(value) => setField("postal_code", value)} value={values.postal_code} />
      {duplicates.map((duplicate) => (
        <View key={duplicate.id}>
          <Text style={styles.banner}>{duplicate.name}</Text>
          {duplicate.archived ? (
            <Pressable accessibilityLabel={copy.customerRestoreDuplicate} accessibilityRole="button" onPress={() => void restore(duplicate)} style={styles.target}>
              <Text style={styles.targetLabel}>{copy.customerRestoreDuplicate}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {duplicates.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setValues((current) => ({ ...current, confirm_duplicate_email: true }));
            idempotencyKey.current = secureRandomUUID();
          }}
          style={styles.target}
        >
          <Text style={styles.targetLabel}>{copy.customerDuplicate}</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" disabled={submitting} onPress={() => void submit()} style={styles.primary}>
        <Text style={styles.primaryLabel}>{copy.createCustomer}</Text>
      </Pressable>
    </ScrollView>
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

function Field(props: { label: string; value: string; onChangeText: (value: string) => void; error?: string }) {
  return (
    <View>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        onChangeText={props.onChangeText}
        style={[styles.input, props.error ? styles.inputError : null]}
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
  flex: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  label: { color: colors.text, fontSize: type.secondary },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: CUSTOMER_TARGET_MIN_PT,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: "#FFFFFF",
  },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  target: {
    minHeight: CUSTOMER_TARGET_MIN_PT,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
  },
  targetLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  primary: {
    minHeight: CUSTOMER_PRIMARY_MIN_PT,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "600" },
});
