import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  CUSTOMER_LIST_LIMIT,
  CUSTOMER_PRIMARY_MIN_PT,
  CUSTOMER_SEARCH_DEBOUNCE_MS,
  CUSTOMER_TARGET_MIN_PT,
  appendCustomerPage,
  customerAnalyticsProperties,
  customerEmptyBody,
  customerListAnnouncement,
  customerListPath,
  customerListRow,
  customerQueryKey,
  customerResponseCurrent,
  customerResultLabel,
  presentCustomerList,
  type CustomerFilter,
  type CustomerRecord,
} from "../../../src/customers/presentation.ts";
import { copy } from "../../../src/i18n/en.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors } from "../../../src/theme.ts";

const PRIMARY = "#464B71";
const GUTTER = 18;

export default function CustomersScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const refreshBootstrap = auth.refreshBootstrap;
  const authStatus = auth.snapshot.status;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<CustomerFilter>("active");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadedQuery, setLoadedQuery] = useState("");
  const [error, setError] = useState<{ message: string; retryable: boolean } | undefined>();
  const requestGen = useRef(0);
  const paging = useRef(false);
  const inFlightQuery = useRef<string | undefined>(undefined);
  const loadedQueryRef = useRef("");
  const query = customerQueryKey(filter, search);

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = searchInput.trim();
      if (next === search) {
        return;
      }
      setLoading(true);
      setSearch(next);
    }, CUSTOMER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, searchInput]);

  useEffect(() => {
    if (authStatus !== "access_expired") {
      return;
    }
    setCustomers([]);
    setNextCursor(null);
    setError(undefined);
    setLoadedQuery("");
    loadedQueryRef.current = "";
  }, [authStatus]);

  const load = useCallback(async () => {
    if (authStatus === "access_expired") {
      setCustomers([]);
      setNextCursor(null);
      setLoading(false);
      setLoadedOnce(true);
      return;
    }
    if (authStatus === "offline_cached") {
      setCustomers([]);
      setNextCursor(null);
      setLoading(false);
      setLoadedOnce(true);
      setError(undefined);
      return;
    }
    if (authStatus !== "authenticated") {
      setLoading(false);
      return;
    }
    if (inFlightQuery.current === query) {
      return;
    }
    const gen = requestGen.current + 1;
    requestGen.current = gen;
    inFlightQuery.current = query;
    const sameQuery = loadedQueryRef.current === query;
    setLoading(true);
    setError(undefined);
    const result = await runOwnerRequest<{ customers: CustomerRecord[]; next_cursor: string | null }>({
      path: customerListPath({ state: filter, search, limit: CUSTOMER_LIST_LIMIT }),
    });
    if (inFlightQuery.current === query) {
      inFlightQuery.current = undefined;
    }
    if (!customerResponseCurrent(gen, requestGen.current)) {
      return;
    }
    setLoading(false);
    setLoadedOnce(true);
    if (!result.ok) {
      if (!sameQuery) {
        setCustomers([]);
        setNextCursor(null);
      }
      loadedQueryRef.current = query;
      setLoadedQuery(query);
      setError({ message: result.error.message || copy.customersLoadError, retryable: result.error.retryable || result.error.code === "RATE_LIMITED" });
      return;
    }
    setCustomers(result.data.customers);
    setNextCursor(result.data.next_cursor);
    loadedQueryRef.current = query;
    setLoadedQuery(query);
    customerAnalyticsProperties();
  }, [authStatus, filter, query, runOwnerRequest, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const view = presentCustomerList({
    authStatus,
    loading,
    loadedOnce,
    customers: loadedQuery === query ? customers : [],
    queryMatches: loadedQuery === query,
    error,
  });
  const resultLabel = customerResultLabel(filter, view.customers.length, view.kind === "loaded" && !nextCursor);

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]} keyboardShouldPersistTaps="handled">
          <View style={styles.headerRow}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>{copy.customersEyebrow}</Text>
              <Text accessibilityRole="header" style={styles.title}>
                {copy.customersTitle}
              </Text>
            </View>
            {view.kind === "offline" ? (
              <View style={styles.offlineBadge}>
                <Text style={styles.offlineBadgeLabel}>{copy.customersOfflineBadge}</Text>
              </View>
            ) : view.showAdd ? (
              <Pressable
                accessibilityLabel={copy.createCustomer}
                accessibilityRole="button"
                onPress={() => router.push("/customers/new")}
                style={styles.add}
              >
                <Text style={styles.addLabel}>+</Text>
              </Pressable>
            ) : null}
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.hidden}>
            {customerListAnnouncement(view.kind)}
          </Text>
          {view.kind === "offline" ? (
            <View style={styles.offlinePanel}>
              <View style={styles.emptyMark}>
                <Text style={styles.emptyGlyph}>↻</Text>
              </View>
              <Text style={styles.offlineTitle}>{copy.customersUnavailable}</Text>
              <Text style={styles.offlineBody}>{copy.customersOfflineBody}</Text>
            </View>
          ) : null}
          {view.kind === "offline" ? (
            <Pressable accessibilityRole="button" onPress={() => void refreshBootstrap()} style={styles.primary}>
              <Text style={styles.primaryLabel}>{copy.customersRetry}</Text>
            </Pressable>
          ) : null}
          {view.kind === "offline" ? <Text style={styles.note}>{copy.customersOfflineNote}</Text> : null}
          {view.kind === "access_expired" ? (
            <Text accessibilityLiveRegion="polite" style={styles.note}>
              {copy.accessExpired}
            </Text>
          ) : null}
          {view.kind !== "offline" && view.kind !== "access_expired" ? (
            <>
              <Text style={styles.searchLabel}>{copy.customersSearch}</Text>
              <TextInput
                accessibilityLabel={copy.customersSearch}
                accessibilityRole="search"
                autoCorrect={false}
                onChangeText={setSearchInput}
                placeholder={copy.customersSearchPlaceholder}
                placeholderTextColor="#5C6680"
                style={styles.search}
                value={searchInput}
              />
              <View style={styles.filters}>
                {(["active", "archived", "all"] as const).map((item) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: filter === item }}
                    key={item}
                    onPress={() => {
                      setLoading(true);
                      setFilter(item);
                    }}
                    style={[styles.filter, filter === item ? styles.filterOn : null]}
                  >
                    <Text style={filter === item ? styles.filterOnLabel : styles.filterLabel}>
                      {item === "active" ? copy.customersActive : item === "archived" ? copy.customersArchived : copy.customersAll}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
          {view.kind === "loading" ? (
            <View accessibilityLabel={copy.customersLoading}>
              <ActivityIndicator color={PRIMARY} />
              <View style={styles.skeleton} />
              <View style={styles.skeleton} />
            </View>
          ) : null}
          {view.refreshing ? <ActivityIndicator accessibilityLabel={copy.customersLoading} color={PRIMARY} /> : null}
          {view.message && (view.kind === "error" || view.kind === "loaded") ? (
            <View style={styles.errorBox}>
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {view.message}
              </Text>
              {view.showRetry ? (
                <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.retry}>
                  <Text style={styles.retryLabel}>{copy.customersRetry}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {resultLabel ? <Text style={styles.count}>{resultLabel}</Text> : null}
          {view.kind === "empty" ? (
            <View style={styles.empty}>
              <View style={styles.emptyMark}>
                <Text style={styles.emptyGlyph}>◌</Text>
              </View>
              <Text style={styles.emptyTitle}>{copy.customersEmpty}</Text>
              <Text style={styles.emptyBody}>{customerEmptyBody(filter)}</Text>
            </View>
          ) : null}
          {view.kind === "loaded"
            ? view.customers.map((customer) => {
                const row = customerListRow(customer);
                return (
                  <Pressable
                    accessibilityLabel={`${row.name}. ${row.status === "archived" ? copy.customerStatusArchived : copy.customerActive}${row.contact ? `. ${row.contact}` : ""}`}
                    accessibilityRole="button"
                    key={row.id}
                    onPress={() => router.push(`/customers/${row.id}`)}
                    style={styles.card}
                  >
                    <View style={styles.avatar}>
                      <Text style={styles.initials}>{row.initials}</Text>
                    </View>
                    <View style={styles.cardCopy}>
                      <Text style={styles.name}>{row.name}</Text>
                      {row.contact ? <Text style={styles.contact}>{row.contact}</Text> : null}
                      {row.status === "archived" ? <Text style={styles.archived}>{copy.customerStatusArchived}</Text> : null}
                    </View>
                    {row.jobCountLabel ? <Text style={styles.jobs}>{row.jobCountLabel}</Text> : null}
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                );
              })
            : null}
          {view.kind === "loaded" && nextCursor ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void loadMore(nextCursor)}
              style={styles.filter}
            >
              <Text style={styles.filterLabel}>{copy.customersShowingNewest}</Text>
            </Pressable>
          ) : null}
          {view.kind === "loaded" && !nextCursor && view.customers.length > 0 ? (
            <Text style={styles.note}>{copy.customersShowingNewest}</Text>
          ) : null}
          {view.showAdd ? (
            <Pressable accessibilityLabel={copy.createCustomer} accessibilityRole="button" onPress={() => router.push("/customers/new")} style={styles.primary}>
              <Text style={styles.primaryLabel}>{copy.createCustomer}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );

  async function loadMore(cursor: string) {
    if (paging.current || authStatus !== "authenticated") {
      return;
    }
    paging.current = true;
    const gen = requestGen.current;
    const result = await runOwnerRequest<{ customers: CustomerRecord[]; next_cursor: string | null }>({
      path: customerListPath({ state: filter, search, cursor, limit: CUSTOMER_LIST_LIMIT }),
    });
    paging.current = false;
    if (!customerResponseCurrent(gen, requestGen.current) || loadedQuery !== query) {
      return;
    }
    if (!result.ok) {
      setError({ message: result.error.message || copy.customersLoadError, retryable: true });
      return;
    }
    setCustomers((current) => appendCustomerPage(current, result.data.customers));
    setNextCursor(result.data.next_cursor);
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  atmosphere: {
    position: "absolute",
    top: -56,
    right: -40,
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: "#E3EDFC",
  },
  content: { paddingHorizontal: GUTTER, paddingBottom: 32, gap: 12 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  headerCopy: { flex: 1 },
  eyebrow: { color: PRIMARY, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  title: { color: "#131829", fontSize: 30, lineHeight: 36, fontWeight: "700", marginTop: 4 },
  add: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
  },
  addLabel: { color: "#FFFFFF", fontSize: 28, lineHeight: 32 },
  hidden: { height: 0, opacity: 0 },
  searchLabel: { color: "#131829", fontSize: 13, fontWeight: "600" },
  search: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#D6DEEB",
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: "#FFFFFF",
    color: "#131829",
    fontSize: 14,
  },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  filter: {
    minHeight: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: "#D6DEEB",
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  filterOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  filterLabel: { color: PRIMARY, fontSize: 13, fontWeight: "600" },
  filterOnLabel: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  count: { color: "#5C6680", fontSize: 12 },
  card: {
    minHeight: CUSTOMER_TARGET_MIN_PT,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6DEEB",
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#E3EDFC",
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { color: PRIMARY, fontSize: 14, fontWeight: "700" },
  cardCopy: { flex: 1, gap: 2 },
  name: { color: "#131829", fontSize: 15, fontWeight: "600" },
  contact: { color: "#5C6680", fontSize: 12 },
  archived: { color: PRIMARY, fontSize: 12, fontWeight: "600" },
  jobs: { color: "#14A88C", fontSize: 12, fontWeight: "500" },
  chevron: { color: "#5C6680", fontSize: 22, lineHeight: 24 },
  note: { color: "#5C6680", fontSize: 12, textAlign: "center" },
  empty: { alignItems: "center", gap: 8, paddingVertical: 24 },
  emptyMark: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: "#E3EDFC",
    alignItems: "center",
    justifyContent: "center",
  },
  emptyGlyph: { color: PRIMARY, fontSize: 36 },
  emptyTitle: { color: "#131829", fontSize: 20, fontWeight: "600", textAlign: "center" },
  emptyBody: { color: "#5C6680", fontSize: 14, lineHeight: 20, textAlign: "center" },
  skeleton: { height: 82, borderRadius: 16, backgroundColor: "#E3EDFC", marginTop: 12 },
  errorBox: { gap: 8 },
  error: { color: "#B8373E", fontSize: 14, lineHeight: 20 },
  retry: { minHeight: CUSTOMER_TARGET_MIN_PT, justifyContent: "center" },
  retryLabel: { color: PRIMARY, fontSize: 16, fontWeight: "600" },
  offlineBadge: {
    minHeight: 32,
    borderRadius: 16,
    backgroundColor: "#FFF2D1",
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  offlineBadgeLabel: { color: PRIMARY, fontSize: 12, fontWeight: "600" },
  offlinePanel: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6DEEB",
    borderRadius: 18,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  offlineTitle: { color: "#131829", fontSize: 18, fontWeight: "600", textAlign: "center" },
  offlineBody: { color: "#5C6680", fontSize: 13, lineHeight: 18, textAlign: "center" },
  primary: {
    minHeight: CUSTOMER_PRIMARY_MIN_PT,
    borderRadius: 16,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600", textAlign: "center" },
});
