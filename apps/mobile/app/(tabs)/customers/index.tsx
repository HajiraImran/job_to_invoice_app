import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../src/i18n/en.ts";
import {
  CUSTOMER_PRIMARY_MIN_PT,
  CUSTOMER_TARGET_MIN_PT,
  customerListAnnouncement,
  presentCustomerList,
  type CustomerRecord,
} from "../../../src/customers/presentation.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

type Filter = "active" | "archived" | "all";

export default function CustomersScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>("active");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | undefined>();

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(async () => {
    if (auth.snapshot.status !== "authenticated") {
      setLoading(false);
      setLoadedOnce(true);
      return;
    }
    setLoading(true);
    setError(undefined);
    const params = new URLSearchParams({ state: filter, limit: "25" });
    if (search) params.set("search", search);
    const result = await auth.runOwnerRequest<{ customers: CustomerRecord[]; next_cursor: string | null }>({
      path: `/v1/customers?${params.toString()}`,
    });
    setLoading(false);
    setLoadedOnce(true);
    if (!result.ok) {
      setCustomers([]);
      setNextCursor(null);
      setError({ message: result.error.message, retryable: result.error.retryable });
      return;
    }
    setCustomers(result.data.customers);
    setNextCursor(result.data.next_cursor);
  }, [auth, filter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const view = presentCustomerList({
    authStatus: auth.snapshot.status,
    loading,
    loadedOnce,
    customers,
    error,
  });

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.gutter }]} style={styles.flex}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.customersTitle}
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.hidden}>
        {customerListAnnouncement(view.kind)}
      </Text>
      <TextInput
        accessibilityLabel={copy.customersSearch}
        onChangeText={setSearchInput}
        placeholder={copy.customersSearch}
        style={styles.input}
        value={searchInput}
      />
      <View style={styles.row}>
        {(["active", "archived", "all"] as const).map((item) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: filter === item }}
            key={item}
            onPress={() => setFilter(item)}
            style={[styles.target, filter === item ? styles.selected : null]}
          >
            <Text style={filter === item ? styles.selectedLabel : styles.targetLabel}>
              {item === "active" ? copy.customersActive : item === "archived" ? copy.customersArchived : copy.customersAll}
            </Text>
          </Pressable>
        ))}
      </View>
      {view.kind === "loading" ? <ActivityIndicator accessibilityLabel={copy.customersLoading} /> : null}
      {view.kind === "offline" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.customersOffline}
        </Text>
      ) : null}
      {view.kind === "error" ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {view.message ?? copy.customersLoadError}
        </Text>
      ) : null}
      {view.kind === "empty" ? <Text style={styles.banner}>{copy.customersEmpty}</Text> : null}
      {view.customers.map((customer) => (
        <Pressable
          accessibilityLabel={customer.name}
          accessibilityRole="button"
          key={customer.id}
          onPress={() => router.push(`/customers/${customer.id}`)}
          style={styles.target}
        >
          <Text style={styles.targetLabel}>{customer.name}</Text>
          {customer.email ? <Text style={styles.hint}>{customer.email}</Text> : null}
        </Pressable>
      ))}
      {nextCursor && view.kind === "loaded" ? (
        <Pressable accessibilityRole="button" onPress={() => void loadMore(nextCursor)} style={styles.target}>
          <Text style={styles.targetLabel}>Load more</Text>
        </Pressable>
      ) : null}
      {view.showAdd ? (
        <Pressable
          accessibilityLabel={copy.addCustomer}
          accessibilityRole="button"
          onPress={() => router.push("/customers/new")}
          style={styles.primary}
        >
          <Text style={styles.primaryLabel}>{copy.addCustomer}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );

  async function loadMore(cursor: string) {
    const params = new URLSearchParams({ state: filter, limit: "25", cursor });
    if (search) params.set("search", search);
    const result = await auth.runOwnerRequest<{ customers: CustomerRecord[]; next_cursor: string | null }>({
      path: `/v1/customers?${params.toString()}`,
    });
    if (result.ok) {
      setCustomers((current) => [...current, ...result.data.customers]);
      setNextCursor(result.data.next_cursor);
    }
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  hidden: { height: 0, opacity: 0 },
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
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  target: {
    minHeight: CUSTOMER_TARGET_MIN_PT,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
  },
  selected: { backgroundColor: colors.navy },
  targetLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  selectedLabel: { color: "#FFFFFF", fontSize: type.secondary, fontWeight: "600" },
  hint: { color: colors.secondary, fontSize: type.secondary },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  primary: {
    minHeight: CUSTOMER_PRIMARY_MIN_PT,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "600" },
});
