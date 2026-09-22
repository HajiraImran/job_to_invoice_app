import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../src/i18n/en.ts";
import {
  emptyItemForm,
  formFromItem,
  itemPatchFromForm,
  type CatalogueItemRecord,
  type ItemFormValues,
} from "../../../src/items/form.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";
import { ItemFields } from "./new.tsx";

export default function EditItemScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const itemId = typeof params.id === "string" ? params.id : "";
  const [item, setItem] = useState<CatalogueItemRecord | undefined>();
  const [values, setValues] = useState<ItemFormValues>(emptyItemForm());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!itemId) {
      setFormError(copy.itemsLoadError);
      setLoading(false);
      return;
    }
    if (auth.snapshot.status !== "authenticated") {
      setFormError(auth.snapshot.status === "access_expired" ? copy.accessExpired : copy.itemsOffline);
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await runOwnerRequest<CatalogueItemRecord>({ path: `/v1/items/${itemId}` });
    setLoading(false);
    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }
    setItem(result.data);
    setValues(formFromItem(result.data));
    setFormError(undefined);
  }, [auth.snapshot.status, itemId, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!item || auth.snapshot.status !== "authenticated") {
      setFormError(auth.snapshot.status === "access_expired" ? copy.accessExpired : copy.itemsOffline);
      return;
    }
    const parsed = itemPatchFromForm(values);
    if (!parsed.ok) {
      const next: Record<string, string> = {};
      for (const field of parsed.field_errors) {
        next[field.field] = field.message;
      }
      setErrors(next);
      setFormError(copy.itemsSaveError);
      return;
    }
    setSaving(true);
    setErrors({});
    const result = await runOwnerRequest<CatalogueItemRecord>({
      path: `/v1/items/${item.id}`,
      method: "PATCH",
      ifMatch: item.version,
      body: parsed.value,
    });
    setSaving(false);
    if (!result.ok) {
      setFormError(result.error.message);
      return;
    }
    setItem(result.data);
    setValues(formFromItem(result.data));
    router.replace("/(tabs)/items");
  }

  async function archive(archived: boolean) {
    if (!item || auth.snapshot.status !== "authenticated") {
      setFormError(copy.itemsOffline);
      return;
    }
    setSaving(true);
    const result = await runOwnerRequest<CatalogueItemRecord>({
      path: `/v1/items/${item.id}/archive`,
      method: "POST",
      ifMatch: item.version,
      body: { archived },
    });
    setSaving(false);
    if (!result.ok) {
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
      <Text style={styles.title}>{copy.itemsEdit}</Text>
      {loading ? <ActivityIndicator color={colors.navy} /> : null}
      {formError ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {formError}
        </Text>
      ) : null}
      {!loading && item ? (
        <>
          <ItemFields errors={errors} values={values} onChange={setValues} />
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void save()}
            style={[styles.button, saving ? styles.buttonDisabled : null]}
          >
            <Text style={styles.buttonLabel}>{saving ? copy.itemsSaving : copy.itemsSave}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void archive(!item.archived_at)}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>{item.archived_at ? copy.itemsRestore : copy.itemsArchive}</Text>
          </Pressable>
        </>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}>
        <Text style={styles.secondaryLabel}>{copy.back}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: space.gutter, gap: space.scale, backgroundColor: colors.background },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  error: { color: colors.danger, fontSize: type.secondary },
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
