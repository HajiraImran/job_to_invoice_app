import { formatUsdCents } from "@job-to-invoice/schemas";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../src/i18n/en.ts";
import type { CatalogueItemRecord } from "../../../src/items/form.ts";
import { presentItemsList } from "../../../src/items/presentation.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

type Filter = "active" | "archived";

export default function ItemsScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>("active");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<CatalogueItemRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | undefined>();

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(
    async (cursor?: string | null) => {
      const appending = Boolean(cursor);
      if (appending) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(undefined);
      if (auth.snapshot.status === "access_expired") {
        setError({ message: copy.accessExpired, retryable: false });
        setLoading(false);
        setLoadingMore(false);
        setLoadedOnce(true);
        return;
      }
      if (auth.snapshot.status !== "authenticated") {
        setError({ message: copy.itemsOffline, retryable: true });
        setLoading(false);
        setLoadingMore(false);
        setLoadedOnce(true);
        return;
      }
      const params = new URLSearchParams();
      params.set("state", filter);
      if (search) {
        params.set("search", search);
      }
      if (cursor) {
        params.set("cursor", cursor);
      }
      const result = await runOwnerRequest<{ items: CatalogueItemRecord[]; next_cursor: string | null }>({
        path: `/v1/items?${params.toString()}`,
      });
      if (!result.ok) {
        setError({ message: result.error.message, retryable: result.error.retryable });
        setLoadedOnce(true);
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      setItems((current) => (appending ? [...current, ...result.data.items] : result.data.items));
      setNextCursor(result.data.next_cursor);
      setLoadedOnce(true);
      setLoading(false);
      setLoadingMore(false);
    },
    [auth.snapshot.status, filter, runOwnerRequest, search],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const view = presentItemsList({
    authStatus: auth.snapshot.status,
    loading,
    loadedOnce,
    items,
    error,
  });

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.scale, paddingBottom: insets.bottom }]}>
      <Text style={styles.title}>{copy.itemsTitle}</Text>
      <Text style={styles.hint}>{copy.itemsSeedHint}</Text>
      {view.showAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.itemsAdd}
          onPress={() => router.push("/(tabs)/items/new")}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>{copy.itemsAdd}</Text>
        </Pressable>
      ) : null}
      <TextInput
        value={searchInput}
        onChangeText={setSearchInput}
        placeholder={copy.itemsSearch}
        accessibilityLabel={copy.itemsSearch}
        style={styles.search}
      />
      <View style={styles.filters}>
        {(["active", "archived"] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="button"
            onPress={() => setFilter(item)}
            style={[styles.filter, filter === item ? styles.filterSelected : null]}
          >
            <Text style={[styles.filterLabel, filter === item ? styles.filterLabelSelected : null]}>
              {item === "active" ? copy.itemsFilterActive : copy.itemsFilterArchived}
            </Text>
          </Pressable>
        ))}
      </View>

      {view.kind === "loading" ? (
        <View accessibilityLiveRegion="polite" style={styles.center}>
          <ActivityIndicator color={colors.navy} />
        </View>
      ) : null}

      {view.kind === "error" || view.kind === "offline" || view.kind === "access_expired" ? (
        <View style={styles.center}>
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {view.message ?? (view.kind === "access_expired" ? copy.accessExpired : copy.itemsLoadError)}
          </Text>
          {view.showRetry ? (
            <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.retry}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {view.kind === "empty" ? (
        <View style={styles.center}>
          <Text style={styles.empty}>{copy.itemsEmpty}</Text>
        </View>
      ) : null}

      {view.items.length > 0 ? (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {view.message ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.message}
            </Text>
          ) : null}
          {view.items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={item.description}
              onPress={() => router.push(`/(tabs)/items/${item.id}`)}
              style={styles.card}
            >
              <Text style={styles.cardTitle}>{item.description}</Text>
              <Text style={styles.cardMeta}>
                {formatUsdCents(item.unit_price_cents)} · {item.default_quantity} {item.unit}
              </Text>
            </Pressable>
          ))}
          {nextCursor && !loadingMore ? (
            <Pressable accessibilityRole="button" onPress={() => void load(nextCursor)} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.loadMore}</Text>
            </Pressable>
          ) : null}
          {loadingMore ? <ActivityIndicator color={colors.navy} /> : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700", marginTop: space.scale },
  hint: { color: colors.secondary, fontSize: type.secondary },
  empty: { color: colors.text, fontSize: type.body },
  error: { color: colors.danger, fontSize: type.secondary },
  search: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: "#FFFFFF",
  },
  filters: { flexDirection: "row", gap: space.scale },
  filter: {
    minHeight: 44,
    minWidth: 44,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    justifyContent: "center",
  },
  filterSelected: { backgroundColor: colors.navy },
  filterLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  filterLabelSelected: { color: "#FFFFFF" },
  button: {
    minHeight: 48,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
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
  center: { gap: space.scale, marginTop: space.gutter },
  list: { gap: space.scale, paddingBottom: 48 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    padding: space.gutter,
    backgroundColor: "#FFFFFF",
    gap: 4,
    minHeight: 44,
  },
  cardTitle: { color: colors.text, fontSize: type.body, fontWeight: "600" },
  cardMeta: { color: colors.secondary, fontSize: type.secondary },
});
