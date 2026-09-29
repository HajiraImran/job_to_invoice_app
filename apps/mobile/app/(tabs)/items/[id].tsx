import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../src/i18n/en.ts";
import {
  emptyItemForm,
  formFromItem,
  itemPatchFromForm,
  type CatalogueItemRecord,
  type ItemFormValues,
} from "../../../src/items/form.ts";
import {
  ITEM_CONTROL_PT,
  ITEM_GUTTER,
  ITEM_PRIMARY_PT,
  itemAnalyticsProperties,
  itemArchiveRequest,
  itemConflict,
  itemDetailClears,
  itemMutationAllowed,
  itemNotFound,
  itemPatchRequest,
  itemSubmitBlocked,
} from "../../../src/items/presentation.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors } from "../../../src/theme.ts";
import { ItemFields } from "./new.tsx";

const PRIMARY = "#464B71";
const TITLE = "#1F2430";
const MUTED = "#636B7D";
const LINE = "#E2E5EC";
const INFO = "#E6F0FF";

export default function EditItemScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const authStatus = auth.snapshot.status;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const itemId = typeof params.id === "string" ? params.id : "";
  const [item, setItem] = useState<CatalogueItemRecord | undefined>();
  const [values, setValues] = useState<ItemFormValues>(emptyItemForm());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [notFound, setNotFound] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!itemId) {
      setNotFound(true);
      setItem(undefined);
      setLoading(false);
      return;
    }
    if (itemDetailClears(authStatus)) {
      setItem(undefined);
      setValues(emptyItemForm());
      setErrors({});
      setFormError(copy.accessExpired);
      setLoading(false);
      setNotFound(false);
      return;
    }
    if (!itemMutationAllowed(authStatus)) {
      setFormError(copy.itemsOffline);
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await runOwnerRequest<CatalogueItemRecord>({ path: `/v1/items/${itemId}` });
    setLoading(false);
    if (!result.ok) {
      if (itemNotFound(result.error.status, result.error.code)) {
        setItem(undefined);
        setValues(emptyItemForm());
        setNotFound(true);
        setFormError(copy.itemsNotFound);
        return;
      }
      setFormError(result.error.message || copy.itemsLoadError);
      return;
    }
    setItem(result.data);
    setValues(formFromItem(result.data));
    setFormError(undefined);
    setNotFound(false);
    setConflict(false);
    setErrors({});
  }, [authStatus, itemId, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!itemDetailClears(authStatus)) {
      return;
    }
    setItem(undefined);
    setValues(emptyItemForm());
    setErrors({});
  }, [authStatus]);

  async function save() {
    if (itemSubmitBlocked(saving) || !item || !itemMutationAllowed(authStatus)) {
      if (!itemMutationAllowed(authStatus)) {
        setFormError(authStatus === "access_expired" ? copy.accessExpired : copy.itemsOffline);
      }
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
    const request = itemPatchRequest(item, parsed.value);
    const result = await runOwnerRequest<CatalogueItemRecord>({
      path: request.path,
      method: request.method,
      ifMatch: request.ifMatch,
      body: request.body,
    });
    setSaving(false);
    if (!result.ok) {
      if (itemConflict(result.error.code)) {
        setConflict(true);
        setFormError(copy.itemsConflict);
        return;
      }
      if (itemNotFound(result.error.status, result.error.code)) {
        setItem(undefined);
        setNotFound(true);
        setFormError(copy.itemsNotFound);
        return;
      }
      const next: Record<string, string> = {};
      for (const field of result.error.field_errors ?? []) {
        next[field.field] = field.message;
      }
      setErrors(next);
      setFormError(result.error.message || copy.itemsSaveError);
      return;
    }
    itemAnalyticsProperties();
    router.replace("/(tabs)/items");
  }

  function confirmArchive(archived: boolean) {
    if (itemSubmitBlocked(saving) || !item || !itemMutationAllowed(authStatus)) {
      return;
    }
    Alert.alert(archived ? copy.itemsArchiveTitle : copy.itemsRestoreTitle, archived ? copy.itemsArchiveBody : copy.itemsRestoreBody, [
      { text: copy.itemsCancel, style: "cancel" },
      { text: archived ? copy.itemsArchive : copy.itemsRestore, onPress: () => void archive(archived) },
    ]);
  }

  async function archive(archived: boolean) {
    if (itemSubmitBlocked(saving) || !item || !itemMutationAllowed(authStatus)) {
      return;
    }
    setSaving(true);
    const request = itemArchiveRequest(item, archived);
    const result = await runOwnerRequest<CatalogueItemRecord>({
      path: request.path,
      method: request.method,
      ifMatch: request.ifMatch,
      body: request.body,
    });
    setSaving(false);
    if (!result.ok) {
      if (itemConflict(result.error.code)) {
        setConflict(true);
        setFormError(copy.itemsConflict);
        return;
      }
      setFormError(result.error.message || copy.itemsSaveError);
      return;
    }
    itemAnalyticsProperties();
    router.replace("/(tabs)/items");
  }

  const archived = Boolean(item?.archived_at);
  const showForm = Boolean(item) && itemMutationAllowed(authStatus) && !notFound;

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
                {copy.itemsEdit}
              </Text>
              <Text style={styles.subtitle}>{copy.itemsEditSubtitle}</Text>
            </View>
          </View>

          {loading && !item ? (
            <View accessibilityLiveRegion="polite" style={styles.panel}>
              <ActivityIndicator color={PRIMARY} />
              <Text style={styles.muted}>{copy.itemsLoading}</Text>
            </View>
          ) : null}

          {authStatus === "access_expired" ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {copy.accessExpired}
            </Text>
          ) : null}

          {authStatus === "offline_cached" ? (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>{copy.itemsOfflineTitle}</Text>
              <Text style={styles.panelBody}>{copy.itemsOfflineBody}</Text>
            </View>
          ) : null}

          {notFound ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {copy.itemsNotFound}
            </Text>
          ) : null}

          {showForm && item ? (
            <>
              {archived ? <Text style={styles.badge}>{copy.itemsArchivedBadge}</Text> : null}
              {formError ? (
                <Text accessibilityLiveRegion="polite" style={styles.error}>
                  {formError}
                </Text>
              ) : null}
              <ItemFields errors={errors} values={values} onChange={setValues} />
              {archived ? (
                <View style={styles.note}>
                  <Text style={styles.noteMark}>i</Text>
                  <Text style={styles.noteBody}>{copy.itemsHistoryNote}</Text>
                </View>
              ) : (
                <Text style={styles.hint}>{copy.itemsPriceHint}</Text>
              )}
              {conflict ? (
                <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.outline}>
                  <Text style={styles.outlineLabel}>{copy.itemsReload}</Text>
                </Pressable>
              ) : null}
              {archived ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: saving, busy: saving }}
                  disabled={saving}
                  onPress={() => confirmArchive(false)}
                  style={[styles.primary, saving ? styles.disabled : null]}
                >
                  <Text style={styles.primaryLabel}>{saving ? copy.itemsSaving : copy.itemsRestore}</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: saving, busy: saving }}
                  disabled={saving}
                  onPress={() => void save()}
                  style={[styles.primary, saving ? styles.disabled : null]}
                >
                  <Text style={styles.primaryLabel}>{saving ? copy.itemsSaving : copy.itemsSave}</Text>
                </Pressable>
              )}
              {archived ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: saving, busy: saving }}
                  disabled={saving}
                  onPress={() => void save()}
                  style={styles.outline}
                >
                  <Text style={styles.outlineLabel}>{copy.itemsSave}</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: saving, busy: saving }}
                  disabled={saving}
                  onPress={() => confirmArchive(true)}
                  style={styles.outline}
                >
                  <Text style={styles.outlineLabel}>{copy.itemsArchive}</Text>
                </Pressable>
              )}
              <Pressable accessibilityRole="button" accessibilityLabel={copy.itemsCancel} onPress={() => router.back()} style={styles.outline}>
                <Text style={styles.outlineLabel}>{copy.itemsCancel}</Text>
              </Pressable>
            </>
          ) : null}
          {!showForm && !loading ? (
            <Pressable accessibilityRole="button" accessibilityLabel={copy.back} onPress={() => router.back()} style={styles.outline}>
              <Text style={styles.outlineLabel}>{copy.back}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
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
  badge: {
    alignSelf: "flex-start",
    backgroundColor: "#FFF3D1",
    color: TITLE,
    fontSize: 12,
    fontWeight: "600",
    overflow: "hidden",
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  note: {
    backgroundColor: INFO,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    gap: 10,
  },
  noteMark: { color: PRIMARY, fontSize: 15, fontWeight: "700" },
  noteBody: { flex: 1, color: PRIMARY, fontSize: 12, lineHeight: 17, fontWeight: "500" },
  hint: { color: MUTED, fontSize: 11, lineHeight: 16 },
  error: { color: "#B8373E", fontSize: 14 },
  panel: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 22,
    padding: 24,
    alignItems: "center",
    gap: 10,
  },
  panelTitle: { color: TITLE, fontSize: 19, fontWeight: "700", textAlign: "center" },
  panelBody: { color: MUTED, fontSize: 13, lineHeight: 19, textAlign: "center" },
  muted: { color: MUTED, fontSize: 13 },
  primary: {
    minHeight: ITEM_PRIMARY_PT,
    backgroundColor: PRIMARY,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.5 },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  outline: {
    minHeight: ITEM_PRIMARY_PT,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  outlineLabel: { color: PRIMARY, fontSize: 16, fontWeight: "600" },
});
