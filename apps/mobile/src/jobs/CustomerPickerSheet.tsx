import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../i18n/en.ts";
import { useAuth } from "../session/AuthProvider.tsx";
import { colors, type } from "../theme.ts";
import type { CustomerRecord } from "../customers/presentation.ts";
import {
  CREATE_JOB_HINT_SIZE,
  CREATE_JOB_HIT,
  CREATE_JOB_LABEL_SIZE,
  CREATE_JOB_PRIMARY_ACTION,
  CREATE_JOB_SHEET_RADIUS,
  presentActiveCustomersOnly,
  presentCustomerRowLabel,
  presentCustomerSecondary,
  presentPickerState,
} from "./create-presentation.ts";

type ListResponse = { customers: CustomerRecord[]; next_cursor?: string | null };

function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return `${first}${second}`.toUpperCase();
}

export function CustomerPickerSheet(props: {
  visible: boolean;
  selectedId: string;
  onClose: () => void;
  onSelect: (id: string, name: string) => void;
  onAdd: () => void;
}) {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | undefined>();
  const generation = useRef(0);

  const load = useCallback(
    async (query: string, after: string | null, append: boolean) => {
      const current = ++generation.current;
      if (auth.snapshot.status !== "authenticated") {
        setLoading(false);
        setError({ message: copy.customersOffline, retryable: false });
        if (!append) setCustomers([]);
        return;
      }
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({ state: "active", limit: "25" });
      if (query.trim()) params.set("search", query.trim());
      if (after) params.set("cursor", after);
      const result = await auth.runOwnerRequest<ListResponse>({ path: `/v1/customers?${params.toString()}` });
      if (current !== generation.current) {
        return;
      }
      setLoading(false);
      setLoadedOnce(true);
      if (!result.ok) {
        setError({ message: result.error.message || copy.customersLoadError, retryable: result.error.retryable });
        if (!append) setCustomers([]);
        return;
      }
      const page = presentActiveCustomersOnly(result.data.customers);
      setCustomers((currentCustomers) => (append ? [...currentCustomers, ...page] : page));
      setCursor(result.data.next_cursor ?? null);
    },
    [auth],
  );

  useEffect(() => {
    if (!props.visible) {
      return;
    }
    setSearch("");
    setCursor(null);
    setLoadedOnce(false);
  }, [props.visible]);

  useEffect(() => {
    if (!props.visible) {
      return;
    }
    const handle = setTimeout(() => {
      void load(search, null, false);
    }, search ? 300 : 0);
    return () => clearTimeout(handle);
  }, [load, props.visible, search]);

  const view = presentPickerState({
    authStatus: auth.snapshot.status,
    loading,
    loadedOnce,
    customers,
    error,
  });

  return (
    <Modal animationType="none" onRequestClose={props.onClose} transparent visible={props.visible}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel={copy.customerPickerClose} onPress={props.onClose} style={styles.dismiss} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text accessibilityRole="header" style={styles.title}>
                {copy.customerPickerTitle}
              </Text>
              <Text style={styles.hint}>{copy.customerPickerHint}</Text>
            </View>
            <Pressable
              accessibilityLabel={copy.customerPickerClose}
              accessibilityRole="button"
              onPress={props.onClose}
              style={styles.closeHit}
            >
              <View style={styles.closeCircle}>
                <Text style={styles.closeLabel}>×</Text>
              </View>
            </Pressable>
          </View>
          <View style={styles.searchWrap}>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.searchIcon}>
              <View style={styles.searchLens} />
              <View style={styles.searchHandle} />
            </View>
            <TextInput
              accessibilityLabel={copy.customersSearch}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setSearch}
              placeholder={copy.customersSearch}
              placeholderTextColor={colors.secondary}
              style={styles.search}
              value={search}
            />
          </View>
          <Pressable
            accessibilityLabel={copy.addNewCustomer}
            accessibilityRole="button"
            onPress={props.onAdd}
            style={styles.add}
          >
            <View style={styles.addMark}>
              <Text style={styles.addPlus}>+</Text>
            </View>
            <Text style={styles.addLabel}>{copy.addNewCustomer}</Text>
            <Text style={styles.rowChevron}>›</Text>
          </Pressable>
          {view.kind === "loading" ? (
            <ActivityIndicator accessibilityLabel={copy.customersLoading} color={CREATE_JOB_PRIMARY_ACTION} />
          ) : null}
          {view.message ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.message}
            </Text>
          ) : null}
          {view.kind === "empty" ? (
            <Text accessibilityLiveRegion="polite" style={styles.empty}>
              {copy.customerPickerEmpty}
            </Text>
          ) : null}
          {view.showRetry ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void load(search, null, false)}
              style={styles.retry}
            >
              <Text style={styles.retryLabel}>{copy.customerPickerRetry}</Text>
            </Pressable>
          ) : null}
          <FlatList
            data={view.customers}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              !search.trim() && view.customers.length > 0 ? (
                <Text style={styles.recent}>{copy.customerPickerRecent}</Text>
              ) : null
            }
            onEndReached={() => {
              if (cursor && !loading && view.kind === "loaded") {
                void load(search, cursor, true);
              }
            }}
            renderItem={({ item }) => {
              const selected = item.id === props.selectedId;
              const secondary = presentCustomerSecondary(item) || copy.customerNoContact;
              return (
                <Pressable
                  accessibilityLabel={
                    presentCustomerSecondary(item) ? presentCustomerRowLabel(item) : `${item.name}, ${copy.customerNoContact}`
                  }
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => props.onSelect(item.id, item.name)}
                  style={[styles.row, selected ? styles.rowSelected : null]}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarLabel}>{customerInitials(item.name)}</Text>
                  </View>
                  <View style={styles.rowCopy}>
                    <Text style={styles.rowName}>{item.name}</Text>
                    <Text style={styles.rowSecondary}>{secondary}</Text>
                  </View>
                  <Text style={styles.rowChevron}>›</Text>
                </Pressable>
              );
            }}
            style={styles.list}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(23,32,48,0.42)", justifyContent: "flex-end" },
  dismiss: { flex: 1 },
  sheet: {
    backgroundColor: colors.surface,
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 12,
    height: "82%",
    borderTopLeftRadius: CREATE_JOB_SHEET_RADIUS,
    borderTopRightRadius: CREATE_JOB_SHEET_RADIUS,
    shadowColor: "#17212B",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D5DCE3",
    marginBottom: 4,
  },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  headerCopy: { flex: 1, gap: 4, paddingTop: 4 },
  title: { color: colors.text, fontSize: 24, lineHeight: 30, fontWeight: "700" },
  closeHit: { minHeight: CREATE_JOB_HIT, minWidth: CREATE_JOB_HIT, justifyContent: "center", alignItems: "center" },
  closeCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#F2F4F7",
    alignItems: "center",
    justifyContent: "center",
  },
  closeLabel: { color: "#52606D", fontSize: 22, lineHeight: 24, fontWeight: "400", marginTop: -2 },
  hint: { color: colors.secondary, fontSize: CREATE_JOB_HINT_SIZE, lineHeight: 20 },
  searchWrap: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: "#E3E8EE",
    borderRadius: 16,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchIcon: { width: 16, height: 16 },
  searchLens: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: "#8A94A6",
  },
  searchHandle: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 6,
    height: 1.5,
    backgroundColor: "#8A94A6",
    transform: [{ rotate: "45deg" }],
  },
  search: {
    flex: 1,
    minHeight: CREATE_JOB_HIT,
    fontSize: type.body,
    color: colors.text,
  },
  add: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#EEF2F6",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addMark: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: CREATE_JOB_PRIMARY_ACTION,
    alignItems: "center",
    justifyContent: "center",
  },
  addPlus: { color: colors.surface, fontSize: 20, fontWeight: "500", lineHeight: 22, marginTop: -1 },
  addLabel: { color: colors.text, fontSize: type.body, fontWeight: "600", flex: 1 },
  error: { color: colors.danger, fontSize: CREATE_JOB_HINT_SIZE },
  empty: { color: colors.secondary, fontSize: CREATE_JOB_LABEL_SIZE, paddingVertical: 8 },
  retry: { minHeight: CREATE_JOB_HIT, justifyContent: "center" },
  retryLabel: { color: CREATE_JOB_PRIMARY_ACTION, fontSize: type.body, fontWeight: "600" },
  recent: {
    color: colors.secondary,
    fontSize: CREATE_JOB_HINT_SIZE,
    fontWeight: "600",
    marginTop: 4,
    marginBottom: 4,
  },
  list: { flex: 1 },
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 12,
  },
  rowSelected: { backgroundColor: "#F3F6FA", borderRadius: 14, paddingHorizontal: 8 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#E7EDF3",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLabel: { color: CREATE_JOB_PRIMARY_ACTION, fontSize: 13, fontWeight: "700" },
  rowCopy: { flex: 1, gap: 2 },
  rowName: { color: colors.text, fontSize: type.body, fontWeight: "700" },
  rowSecondary: { color: colors.secondary, fontSize: CREATE_JOB_HINT_SIZE },
  rowChevron: { color: "#8A94A6", fontSize: 22, lineHeight: 24, fontWeight: "400" },
});
