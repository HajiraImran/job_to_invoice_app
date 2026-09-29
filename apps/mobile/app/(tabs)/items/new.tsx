import { LINE_UNITS, type LineUnit } from "@job-to-invoice/schemas";
import { useRouter } from "expo-router";
import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { copy } from "../../../src/i18n/en.ts";
import { emptyItemForm, firstItemFieldError, itemCreateFromForm, type ItemFormValues } from "../../../src/items/form.ts";
import {
  ITEM_CONTROL_PT,
  ITEM_GUTTER,
  ITEM_PRIMARY_PT,
  ITEM_TARGET_MIN_PT,
  itemAnalyticsProperties,
  itemFormShowsCustomLabel,
  itemIdempotencyAfterFailure,
  itemMutationAllowed,
  itemSubmitBlocked,
} from "../../../src/items/presentation.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors } from "../../../src/theme.ts";

const PRIMARY = "#464B71";
const TITLE = "#1F2430";
const MUTED = "#636B7D";
const LINE = "#E2E5EC";

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
  const authStatus = auth.snapshot.status;
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
  const descriptionRef = useRef<TextInput>(null);
  const customRef = useRef<TextInput>(null);
  const quantityRef = useRef<TextInput>(null);
  const priceRef = useRef<TextInput>(null);
  const discountRef = useRef<TextInput>(null);
  const taxRef = useRef<TextInput>(null);

  const parsed = useMemo(() => itemCreateFromForm(values, itemId.current ?? ""), [values]);
  const blocked = !itemMutationAllowed(authStatus);

  function focusField(field: string | undefined) {
    const target =
      field === "description"
        ? descriptionRef
        : field === "custom_unit_label"
          ? customRef
          : field === "default_quantity"
            ? quantityRef
            : field === "unit_price_cents"
              ? priceRef
              : field === "discount_cents"
                ? discountRef
                : field === "tax_bp"
                  ? taxRef
                  : undefined;
    target?.current?.focus();
  }

  async function submit() {
    if (itemSubmitBlocked(submitting)) {
      return;
    }
    if (!itemMutationAllowed(authStatus)) {
      setFormError(authStatus === "access_expired" ? copy.accessExpired : copy.itemsOffline);
      return;
    }
    if (!parsed.ok) {
      const next: Record<string, string> = {};
      for (const item of parsed.field_errors) {
        next[item.field] = item.message;
      }
      setErrors(next);
      setFormError(copy.itemsSaveError);
      focusField(firstItemFieldError(next));
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
      idempotencyKey.current = itemIdempotencyAfterFailure(idempotencyKey.current, result.error.code) ?? secureRandomUUID();
      focusField(firstItemFieldError(next));
      return;
    }
    itemAnalyticsProperties();
    router.replace("/(tabs)/items");
  }

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <View style={styles.headerRow}>
            <Pressable accessibilityRole="button" accessibilityLabel={copy.back} onPress={() => router.back()} style={styles.icon}>
              <Text style={styles.iconLabel}>‹</Text>
            </Pressable>
            <View style={styles.headerCopy}>
              <Text accessibilityRole="header" style={styles.title}>
                {copy.itemsAdd}
              </Text>
              <Text style={styles.subtitle}>{copy.itemsAddSubtitle}</Text>
            </View>
          </View>
          {blocked ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {authStatus === "access_expired" ? copy.accessExpired : copy.itemsOffline}
            </Text>
          ) : (
            <>
              {formError ? (
                <Text accessibilityLiveRegion="polite" style={styles.error}>
                  {formError}
                </Text>
              ) : null}
              <ItemFields
                errors={errors}
                values={values}
                onChange={setValues}
                descriptionRef={descriptionRef}
                customRef={customRef}
                quantityRef={quantityRef}
                priceRef={priceRef}
                discountRef={discountRef}
                taxRef={taxRef}
              />
              <Text style={styles.hint}>{copy.itemsPriceHint}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: submitting, busy: submitting }}
                disabled={submitting}
                onPress={() => void submit()}
                style={[styles.primary, submitting ? styles.disabled : null]}
              >
                <Text style={styles.primaryLabel}>{submitting ? copy.itemsSaving : copy.itemsSave}</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

export function ItemFields({
  values,
  errors,
  onChange,
  descriptionRef,
  customRef,
  quantityRef,
  priceRef,
  discountRef,
  taxRef,
}: {
  values: ItemFormValues;
  errors: Record<string, string>;
  onChange: (values: ItemFormValues) => void;
  descriptionRef?: RefObject<TextInput | null>;
  customRef?: RefObject<TextInput | null>;
  quantityRef?: RefObject<TextInput | null>;
  priceRef?: RefObject<TextInput | null>;
  discountRef?: RefObject<TextInput | null>;
  taxRef?: RefObject<TextInput | null>;
}) {
  const [unitOpen, setUnitOpen] = useState(false);
  const showCustom = itemFormShowsCustomLabel(values);
  return (
    <View style={styles.form}>
      <Field label={copy.itemsDescription} error={errors.description}>
        <TextInput
          ref={descriptionRef}
          value={values.description}
          onChangeText={(description) => onChange({ ...values, description })}
          style={styles.input}
          accessibilityLabel={copy.itemsDescription}
        />
      </Field>
      <View style={styles.row}>
        <View style={styles.half}>
          <Text style={styles.label}>{copy.itemsUnit}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.itemsUnit}
            accessibilityState={{ expanded: unitOpen }}
            onPress={() => setUnitOpen(true)}
            style={styles.input}
          >
            <Text style={styles.inputText}>{unitLabel(values.unit)}</Text>
            <Text style={styles.caret}>⌄</Text>
          </Pressable>
          {errors.unit ? (
            <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
              {errors.unit}
            </Text>
          ) : null}
        </View>
        <View style={styles.half}>
          <Field label={copy.itemsQuantity} error={errors.default_quantity}>
            <TextInput
              ref={quantityRef}
              value={values.default_quantity}
              onChangeText={(default_quantity) => onChange({ ...values, default_quantity })}
              keyboardType="decimal-pad"
              style={styles.input}
              accessibilityLabel={copy.itemsQuantity}
            />
          </Field>
        </View>
      </View>
      {showCustom ? (
        <Field label={copy.itemsCustomUnit} error={errors.custom_unit_label}>
          <TextInput
            ref={customRef}
            value={values.custom_unit_label}
            onChangeText={(custom_unit_label) => onChange({ ...values, custom_unit_label })}
            style={styles.input}
            accessibilityLabel={copy.itemsCustomUnit}
            maxLength={20}
          />
        </Field>
      ) : null}
      <Field label={copy.itemsUnitPrice} error={errors.unit_price_cents}>
        <View style={styles.input}>
          <Text style={styles.prefix}>$</Text>
          <TextInput
            ref={priceRef}
            value={values.unit_price}
            onChangeText={(unit_price) => onChange({ ...values, unit_price: unit_price.replace(/[$,]/g, "") })}
            keyboardType="decimal-pad"
            style={styles.money}
            accessibilityLabel={`${copy.itemsUnitPrice}, USD`}
          />
        </View>
      </Field>
      <View style={styles.row}>
        <View style={styles.half}>
          <Field label={copy.itemsTax} error={errors.tax_bp}>
            <View style={styles.input}>
              <TextInput
                ref={taxRef}
                value={values.tax_percent}
                onChangeText={(tax_percent) => onChange({ ...values, tax_percent: tax_percent.replace("%", "") })}
                keyboardType="decimal-pad"
                style={styles.money}
                accessibilityLabel={`${copy.itemsTax}, percent`}
              />
              <Text style={styles.suffix}>%</Text>
            </View>
          </Field>
        </View>
        <View style={styles.half}>
          <Field label={copy.itemsDiscount} error={errors.discount_cents}>
            <View style={styles.input}>
              <Text style={styles.prefix}>$</Text>
              <TextInput
                ref={discountRef}
                value={values.discount}
                onChangeText={(discount) => onChange({ ...values, discount: discount.replace(/[$,]/g, "") })}
                keyboardType="decimal-pad"
                style={styles.money}
                accessibilityLabel={`${copy.itemsDiscount}, USD`}
              />
            </View>
          </Field>
        </View>
      </View>
      <Modal visible={unitOpen} transparent animationType="fade" onRequestClose={() => setUnitOpen(false)}>
        <Pressable accessibilityRole="button" accessibilityLabel={copy.itemsCancel} onPress={() => setUnitOpen(false)} style={styles.scrim}>
          <View style={styles.sheet}>
            {LINE_UNITS.map((unit) => {
              const selected = values.unit === unit;
              return (
                <Pressable
                  key={unit}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={unitLabel(unit)}
                  onPress={() => {
                    onChange({ ...values, unit, custom_unit_label: unit === "custom" ? values.custom_unit_label : "" });
                    setUnitOpen(false);
                  }}
                  style={[styles.choice, selected ? styles.choiceSelected : null]}
                >
                  <Text style={[styles.choiceLabel, selected ? styles.choiceLabelSelected : null]}>{unitLabel(unit)}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.fieldError}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  atmosphere: {
    position: "absolute",
    top: -55,
    right: -20,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "#E3EDFC",
  },
  content: { paddingHorizontal: ITEM_GUTTER, gap: 16 },
  headerRow: { minHeight: ITEM_CONTROL_PT, flexDirection: "row", alignItems: "center", gap: 12 },
  headerCopy: { flex: 1 },
  title: { color: TITLE, fontSize: 26, lineHeight: 35, fontWeight: "700" },
  subtitle: { color: MUTED, fontSize: 12, lineHeight: 16 },
  icon: {
    width: ITEM_CONTROL_PT,
    height: ITEM_CONTROL_PT,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: LINE,
    alignItems: "center",
    justifyContent: "center",
  },
  iconLabel: { color: PRIMARY, fontSize: 22, lineHeight: 28 },
  form: { gap: 14 },
  field: { gap: 7 },
  label: { color: TITLE, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  row: { flexDirection: "row", gap: 10 },
  half: { flex: 1, gap: 7 },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 15,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  inputText: { flex: 1, color: TITLE, fontSize: 14 },
  money: { flex: 1, minHeight: ITEM_TARGET_MIN_PT, color: TITLE, fontSize: 14 },
  prefix: { color: TITLE, fontSize: 14 },
  suffix: { color: TITLE, fontSize: 14 },
  caret: { color: MUTED, fontSize: 18 },
  hint: { color: MUTED, fontSize: 11, lineHeight: 16 },
  error: { color: "#B8373E", fontSize: 14 },
  fieldError: { color: "#B8373E", fontSize: 13 },
  primary: {
    minHeight: ITEM_PRIMARY_PT,
    backgroundColor: PRIMARY,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.5 },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  scrim: { flex: 1, backgroundColor: "rgba(23,50,77,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#FFFFFF", padding: ITEM_GUTTER, gap: 8, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  choice: {
    minHeight: ITEM_TARGET_MIN_PT,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LINE,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  choiceSelected: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  choiceLabel: { color: TITLE, fontSize: 15, fontWeight: "600" },
  choiceLabelSelected: { color: "#FFFFFF" },
});
