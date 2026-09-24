import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../../src/crypto/uuid.ts";
import {
  customerMutationDenied,
  customerPatchFromForm,
  emptyCustomerForm,
  type CustomerFormValues,
} from "../../../../src/customers/form.ts";
import { CUSTOMER_PRIMARY_MIN_PT, CUSTOMER_TARGET_MIN_PT, type CustomerDuplicate, type CustomerRecord } from "../../../../src/customers/presentation.ts";
import { copy } from "../../../../src/i18n/en.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

export default function EditCustomerScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const customerId = typeof params.id === "string" ? params.id : "";
  const [original, setOriginal] = useState<CustomerFormValues>(emptyCustomerForm());
  const [values, setValues] = useState<CustomerFormValues>(emptyCustomerForm());
  const [version, setVersion] = useState(1);
  const [formError, setFormError] = useState<string | undefined>();
  const [duplicates, setDuplicates] = useState<CustomerDuplicate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (auth.snapshot.status !== "authenticated" || !customerId) {
      setLoading(false);
      return;
    }
    void auth.runOwnerRequest<CustomerRecord>({ path: `/v1/customers/${customerId}` }).then((result) => {
      setLoading(false);
      if (!result.ok) {
        setFormError(result.error.message);
        return;
      }
      const next = formFromCustomer(result.data);
      setOriginal(next);
      setValues(next);
      setVersion(result.data.version);
    });
  }, [auth, customerId]);

  function setField<K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    if (customerMutationDenied(auth.snapshot.status)) {
      setFormError(copy.customersOffline);
      return;
    }
    const parsed = customerPatchFromForm(values, original);
    if (!parsed.ok) {
      setFormError(parsed.field_errors[0]?.message ?? copy.jobCreateError);
      return;
    }
    const body: Record<string, unknown> = {};
    if (parsed.value.name !== undefined) body.name = parsed.value.name;
    if (parsed.value.email !== undefined) body.email = parsed.value.email;
    if (parsed.value.phone !== undefined) body.phone = parsed.value.phone;
    if (parsed.value.billing_address !== undefined) body.billing_address = parsed.value.billing_address;
    if (parsed.value.confirm_duplicate_email) body.confirm_duplicate_email = true;
    const result = await auth.runOwnerRequest<CustomerRecord>({
      path: `/v1/customers/${customerId}`,
      method: "PATCH",
      body,
      ifMatch: version,
      idempotencyKey: secureRandomUUID(),
    });
    if (!result.ok) {
      if (result.error.code === "DUPLICATE_CUSTOMER_EMAIL") {
        setDuplicates(result.error.duplicates ?? []);
        setFormError(copy.customerDuplicate);
        return;
      }
      setFormError(result.error.code === "VERSION_CONFLICT" ? copy.customerVersionConflict : result.error.message);
      return;
    }
    router.replace(`/customers/${customerId}`);
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.gutter }]} style={styles.flex}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.saveCustomer}
      </Text>
      {loading ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.customersLoading}
        </Text>
      ) : null}
      {formError ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {formError}
        </Text>
      ) : null}
      <Field label={copy.customerName} onChangeText={(value) => setField("name", value)} value={values.name} />
      <Field label={copy.customerEmail} onChangeText={(value) => setField("email", value)} value={values.email} />
      <Field label={copy.customerPhone} onChangeText={(value) => setField("phone", value)} value={values.phone} />
      <Field label={copy.addressLine1} onChangeText={(value) => setField("line1", value)} value={values.line1} />
      <Field label={copy.addressLine2} onChangeText={(value) => setField("line2", value)} value={values.line2} />
      <Field label={copy.city} onChangeText={(value) => setField("city", value)} value={values.city} />
      <Field label={copy.state} onChangeText={(value) => setField("state", value)} value={values.state} />
      <Field label={copy.postalCode} onChangeText={(value) => setField("postal_code", value)} value={values.postal_code} />
      {duplicates.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setValues((current) => ({ ...current, confirm_duplicate_email: true }));
          }}
          style={styles.target}
        >
          <Text style={styles.targetLabel}>
            {duplicates.some((item) => item.archived) ? copy.customerRestoreDuplicate : copy.customerDuplicate}
          </Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => void submit()} style={styles.primary}>
        <Text style={styles.primaryLabel}>{copy.saveCustomer}</Text>
      </Pressable>
    </ScrollView>
  );
}

function formFromCustomer(customer: CustomerRecord): CustomerFormValues {
  return {
    name: customer.name,
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    line1: customer.billing_address?.line1 ?? "",
    line2: customer.billing_address?.line2 ?? "",
    city: customer.billing_address?.city ?? "",
    state: customer.billing_address?.state ?? "",
    postal_code: customer.billing_address?.postal_code ?? "",
    confirm_duplicate_email: false,
  };
}

function Field(props: { label: string; value: string; onChangeText: (value: string) => void }) {
  return (
    <View>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput accessibilityLabel={props.label} onChangeText={props.onChangeText} style={styles.input} value={props.value} />
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
