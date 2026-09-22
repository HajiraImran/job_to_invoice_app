import { LINE_UNITS, type LineUnit } from "@job-to-invoice/schemas";
import { useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../src/crypto/uuid.ts";
import { copy } from "../../../src/i18n/en.ts";
import { emptyItemForm, itemCreateFromForm, type ItemFormValues } from "../../../src/items/form.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

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

export default function NewItemScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [values, setValues] = useState<ItemFormValues>(emptyItemForm());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const itemId = useRef<string | undefined>(undefined);
  itemId.current = retainOrCreateSetupIdempotencyKey(itemId.current);
  const idempotencyKey = useRef<string | undefined>(undefined);
  idempotencyKey.current = retainOrCreateSetupIdempotencyKey(idempotencyKey.current);

  const parsed = useMemo(() => itemCreateFromForm(values, itemId.current ?? ""), [values]);

  async function submit() {
    if (auth.snapshot.status !== "authenticated") {
      setFormError(auth.snapshot.status === "access_expired" ? copy.accessExpired : copy.itemsOffline);
      return;
    }
    if (!parsed.ok) {
      const next: Record<string, string> = {};
      for (const item of parsed.field_errors) {
        next[item.field] = item.message;
      }
      setErrors(next);
      setFormError(copy.itemsSaveError);
      return;
    }
    setSubmitting(true);
    setFormError(undefined);
    setErrors({});
    const result = await runOwnerRequest({
      path: "/v1/items",
      method: "POST",
      idempotencyKey: idempotencyKey.current ?? secureRandomUUID(),
      body: parsed.value,
    });
    setSubmitting(false);
    if (!result.ok) {
      const next: Record<string, string> = {};
      for (const item of result.error.field_errors ?? []) {
        next[item.field] = item.message;
      }
      setErrors(next);
      setFormError(result.error.message);
      return;
    }
    router.replace("/(tabs)/items");
  }

  return (
    <ScrollView
      contentContainerStyle={[styles.screen, { paddingTop: insets.top + space.scale, paddingBottom: insets.bottom + 48 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>{copy.itemsAdd}</Text>
      <Text style={styles.hint}>{copy.itemsSeedHint}</Text>
      {formError ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {formError}
        </Text>
      ) : null}
      <ItemFields errors={errors} values={values} onChange={setValues} />
      <Pressable
        accessibilityRole="button"
        disabled={submitting}
        onPress={() => void submit()}
        style={[styles.button, submitting ? styles.buttonDisabled : null]}
      >
        <Text style={styles.buttonLabel}>{submitting ? copy.itemsSaving : copy.itemsSave}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
        <Text style={styles.secondaryLabel}>{copy.back}</Text>
      </Pressable>
    </ScrollView>
  );
}

export function ItemFields({
  values,
  errors,
  onChange,
}: {
  values: ItemFormValues;
  errors: Record<string, string>;
  onChange: (values: ItemFormValues) => void;
}) {
  return (
    <>
      <Text style={styles.label}>{copy.quoteDescription}</Text>
      <TextInput
        value={values.description}
        onChangeText={(description) => onChange({ ...values, description })}
        style={styles.input}
        accessibilityLabel={copy.quoteDescription}
      />
      {errors.description ? <Text style={styles.error}>{errors.description}</Text> : null}
      <Text style={styles.label}>{copy.quoteUnit}</Text>
      <View style={styles.wrap}>
        {LINE_UNITS.map((unit) => (
          <Pressable
            key={unit}
            accessibilityRole="button"
            onPress={() => onChange({ ...values, unit, custom_unit_label: unit === "custom" ? values.custom_unit_label : "" })}
            style={[styles.choice, values.unit === unit ? styles.choiceSelected : null]}
          >
            <Text style={[styles.choiceLabel, values.unit === unit ? styles.choiceLabelSelected : null]}>
              {unitLabel(unit)}
            </Text>
          </Pressable>
        ))}
      </View>
      {values.unit === "custom" ? (
        <>
          <Text style={styles.label}>{copy.quoteCustomUnit}</Text>
          <TextInput
            value={values.custom_unit_label}
            onChangeText={(custom_unit_label) => onChange({ ...values, custom_unit_label })}
            style={styles.input}
            accessibilityLabel={copy.quoteCustomUnit}
          />
        </>
      ) : null}
      <Text style={styles.label}>{copy.quoteQuantity}</Text>
      <TextInput
        value={values.default_quantity}
        onChangeText={(default_quantity) => onChange({ ...values, default_quantity })}
        keyboardType="decimal-pad"
        style={styles.input}
        accessibilityLabel={copy.quoteQuantity}
      />
      {errors.default_quantity ? <Text style={styles.error}>{errors.default_quantity}</Text> : null}
      <Text style={styles.label}>{copy.quoteUnitPrice}</Text>
      <TextInput
        value={values.unit_price}
        onChangeText={(unit_price) => onChange({ ...values, unit_price })}
        keyboardType="decimal-pad"
        style={styles.input}
        accessibilityLabel={copy.quoteUnitPrice}
      />
      {errors.unit_price_cents ? <Text style={styles.error}>{errors.unit_price_cents}</Text> : null}
      <Text style={styles.label}>{copy.quoteDiscount}</Text>
      <TextInput
        value={values.discount}
        onChangeText={(discount) => onChange({ ...values, discount })}
        keyboardType="decimal-pad"
        style={styles.input}
        accessibilityLabel={copy.quoteDiscount}
      />
      <Text style={styles.label}>{copy.quoteTax}</Text>
      <TextInput
        value={values.tax_percent}
        onChangeText={(tax_percent) => onChange({ ...values, tax_percent })}
        keyboardType="decimal-pad"
        style={styles.input}
        accessibilityLabel={copy.quoteTax}
      />
    </>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: space.gutter, gap: space.scale, backgroundColor: colors.background },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  hint: { color: colors.secondary, fontSize: type.secondary },
  label: { color: colors.text, fontSize: type.secondary, fontWeight: "600" },
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
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.scale },
  choice: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    justifyContent: "center",
  },
  choiceSelected: { backgroundColor: colors.navy },
  choiceLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  choiceLabelSelected: { color: "#FFFFFF" },
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
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});
