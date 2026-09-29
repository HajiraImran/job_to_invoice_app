import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../src/i18n/en.ts";
import type { CatalogueItemRecord } from "../../../src/items/form.ts";
import {
  ITEM_CONTROL_PT,
  ITEM_GUTTER,
  ITEM_LIST_LIMIT,
  ITEM_PRIMARY_PT,
  ITEM_SEARCH_DEBOUNCE_MS,
  ITEM_TARGET_MIN_PT,
  appendItemPage,
  itemAnalyticsProperties,
  itemEmptyCopy,
  itemListAnnouncement,
  itemListPath,
  itemListRow,
  itemQueryKey,
  itemResponseCurrent,
  itemSearchQuery,
  presentItemsList,
  type ItemFilter,
} from "../../../src/items/presentation.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors } from "../../../src/theme.ts";

const PRIMARY = "#464B71";
const TITLE = "#1F2430";
const MUTED = "#636B7D";
const LINE = "#E2E5EC";
const INFO = "#E6F0FF";

export default function ItemsScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const refreshBootstrap = auth.refreshBootstrap;
  const authStatus = auth.snapshot.status;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<ItemFilter>("active");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<CatalogueItemRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loadedQuery, setLoadedQuery] = useState("");
  const [error, setError] = useState<{ message: string; retryable: boolean } | undefined>();
  const requestGen = useRef(0);
  const paging = useRef(false);
  const inFlightQuery = useRef<string | undefined>(undefined);
  const loadedQueryRef = useRef("");
  const query = itemQueryKey(filter, search);

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = itemSearchQuery(searchInput);
      if (next === search) {
        return;
      }
      setLoading(true);
      setSearch(next);
    }, ITEM_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search, searchInput]);

  useEffect(() => {
    if (authStatus !== "access_expired") {
      return;
    }
    setItems([]);
    setNextCursor(null);
    setError(undefined);
    setLoadedQuery("");
    loadedQueryRef.current = "";
  }, [authStatus]);

  const load = useCallback(async () => {
    if (authStatus === "access_expired") {
      setItems([]);
      setNextCursor(null);
      setLoading(false);
      setLoadedOnce(true);
      return;
    }
    if (authStatus === "offline_cached") {
      setItems([]);
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
    const result = await runOwnerRequest<{ items: CatalogueItemRecord[]; next_cursor: string | null }>({
      path: itemListPath({ state: filter, search, limit: ITEM_LIST_LIMIT }),
    });
    if (inFlightQuery.current === query) {
      inFlightQuery.current = undefined;
    }
    if (!itemResponseCurrent(gen, requestGen.current)) {
      return;
    }
    setLoading(false);
    setLoadedOnce(true);
    if (!result.ok) {
      if (!sameQuery) {
        setItems([]);
        setNextCursor(null);
      }
      loadedQueryRef.current = query;
      setLoadedQuery(query);
      setError({
        message: result.error.message || copy.itemsLoadError,
        retryable: result.error.retryable || result.error.code === "RATE_LIMITED",
      });
      return;
    }
    setItems(result.data.items);
    setNextCursor(result.data.next_cursor);
    loadedQueryRef.current = query;
    setLoadedQuery(query);
    itemAnalyticsProperties();
  }, [authStatus, filter, query, runOwnerRequest, search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor || paging.current || authStatus !== "authenticated") {
      return;
    }
    const cursor = nextCursor;
    const gen = requestGen.current;
    const requested = query;
    paging.current = true;
    setLoadingMore(true);
    const result = await runOwnerRequest<{ items: CatalogueItemRecord[]; next_cursor: string | null }>({
      path: itemListPath({ state: filter, search, cursor, limit: ITEM_LIST_LIMIT }),
    });
    paging.current = false;
    setLoadingMore(false);
    if (!itemResponseCurrent(gen, requestGen.current) || loadedQueryRef.current !== requested) {
      return;
    }
    if (!result.ok) {
      setError({
        message: result.error.message || copy.itemsLoadError,
        retryable: result.error.retryable || result.error.code === "RATE_LIMITED",
      });
      return;
    }
    setItems((current) => appendItemPage(current, result.data.items));
    setNextCursor(result.data.next_cursor);
  }

  const view = presentItemsList({
    authStatus,
    loading,
    loadedOnce,
    items: loadedQuery === query ? items : [],
    queryMatches: loadedQuery === query,
    error: loadedQuery === query || !loadedQuery ? error : undefined,
  });
  const emptyCopy = itemEmptyCopy(filter);
  const showControls = view.kind !== "offline" && view.kind !== "access_expired";

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            view.kind === "loaded" || view.kind === "empty" ? (
              <RefreshControl refreshing={view.refreshing} onRefresh={() => void load()} tintColor={PRIMARY} />
            ) : undefined
          }
        >
          <View style={styles.headerRow}>
            <View style={styles.headerCopy}>
              <Text accessibilityRole="header" style={styles.title}>
                {copy.itemsTitle}
              </Text>
              <Text style={styles.subtitle}>{copy.itemsSubtitle}</Text>
            </View>
            {view.showAdd ? (
              <Pressable
                accessibilityLabel={copy.itemsAdd}
                accessibilityRole="button"
                onPress={() => router.push("/(tabs)/items/new")}
                style={styles.add}
              >
                <Text style={styles.addLabel}>＋</Text>
              </Pressable>
            ) : null}
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.hidden}>
            {itemListAnnouncement(view.kind)}
          </Text>

          {view.kind === "offline" ? (
            <>
              <View style={styles.warn}>
                <Text style={styles.warnMark}>!</Text>
                <Text style={styles.warnBody}>{copy.itemsOffline}</Text>
              </View>
              <View style={styles.panel}>
                <View style={styles.mark}>
                  <Text style={styles.glyph}>↯</Text>
                </View>
                <Text style={styles.panelTitle}>{copy.itemsOfflineTitle}</Text>
                <Text style={styles.panelBody}>{copy.itemsOfflineBody}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.itemsTryAgain}
                  onPress={() => void refreshBootstrap()}
                  style={styles.outline}
                >
                  <Text style={styles.outlineLabel}>{copy.itemsTryAgain}</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {view.kind === "access_expired" ? (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>{copy.accessExpired}</Text>
            </View>
          ) : null}

          {showControls ? (
            <>
              <View style={styles.search}>
                <Text style={styles.searchGlyph}>⌕</Text>
                <TextInput
                  value={searchInput}
                  onChangeText={setSearchInput}
                  placeholder={copy.itemsSearch}
                  placeholderTextColor={MUTED}
                  accessibilityLabel={copy.itemsSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.searchInput}
                />
              </View>
              <View style={styles.filters}>
                {(["active", "archived"] as const).map((item) => {
                  const selected = filter === item;
                  const label = item === "active" ? copy.itemsFilterActive : copy.itemsFilterArchived;
                  return (
                    <Pressable
                      key={item}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      accessibilityState={{ selected }}
                      onPress={() => {
                        if (item === filter) {
                          return;
                        }
                        setLoading(true);
                        setFilter(item);
                      }}
                      style={[styles.filter, selected ? styles.filterSelected : null]}
                    >
                      <Text style={[styles.filterLabel, selected ? styles.filterLabelSelected : null]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {view.kind === "loading" ? (
            <View accessibilityLiveRegion="polite">
              <View style={styles.skeleton} />
              <View style={styles.skeleton} />
              <View style={styles.skeleton} />
              <ActivityIndicator color={PRIMARY} />
            </View>
          ) : null}

          {view.kind === "error" ? (
            <View style={styles.panel}>
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {view.message ?? copy.itemsLoadError}
              </Text>
              {view.showRetry ? (
                <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.outline}>
                  <Text style={styles.outlineLabel}>{copy.retry}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {view.kind === "empty" ? (
            <View style={styles.panel}>
              <View style={styles.mark}>
                <Text style={styles.glyph}>□</Text>
              </View>
              <Text style={styles.panelTitle}>{emptyCopy.title}</Text>
              <Text style={styles.panelBody}>{emptyCopy.body}</Text>
            </View>
          ) : null}

          {view.kind === "loaded" ? (
            <>
              {filter === "active" ? (
                <View style={styles.note}>
                  <Text style={styles.noteMark}>i</Text>
                  <Text style={styles.noteBody}>{copy.itemsPriceNote}</Text>
                </View>
              ) : null}
              {view.message ? (
                <View>
                  <Text accessibilityLiveRegion="polite" style={styles.error}>
                    {view.message}
                  </Text>
                  {view.showRetry ? (
                    <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.outline}>
                      <Text style={styles.outlineLabel}>{copy.retry}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              {view.items.map((item) => {
                const row = itemListRow(item);
                const label = `${row.description}, ${row.unit}, ${row.price}, ${row.tax}${row.archived ? `, ${copy.itemsArchivedBadge}` : ""}`;
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    onPress={() => router.push(`/(tabs)/items/${item.id}`)}
                    style={styles.card}
                  >
                    <View style={styles.cardTop}>
                      <Text style={styles.cardTitle}>{row.description}</Text>
                      <Text style={styles.chevron}>›</Text>
                    </View>
                    {row.archived ? (
                      <Text style={styles.badge}>{copy.itemsArchivedBadge}</Text>
                    ) : null}
                    <View style={styles.chips}>
                      <Text style={styles.chip}>{row.unit}</Text>
                      <Text style={styles.chip} accessibilityLabel={`${copy.itemsUnitPrice} ${row.price}`}>
                        {row.price}
                      </Text>
                      <Text style={styles.chip} accessibilityLabel={row.tax}>
                        {row.tax}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {nextCursor ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={copy.loadMore}
                  disabled={loadingMore}
                  onPress={() => void loadMore()}
                  style={styles.outline}
                >
                  <Text style={styles.outlineLabel}>{loadingMore ? copy.itemsLoading : copy.loadMore}</Text>
                </Pressable>
              ) : null}
              {nextCursor ? <Text style={styles.more}>{copy.itemsMore}</Text> : null}
            </>
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
  title: { color: TITLE, fontSize: 28, lineHeight: 38, fontWeight: "700" },
  subtitle: { color: MUTED, fontSize: 12, lineHeight: 16 },
  add: {
    width: ITEM_CONTROL_PT,
    height: ITEM_CONTROL_PT,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: LINE,
    alignItems: "center",
    justifyContent: "center",
  },
  addLabel: { color: PRIMARY, fontSize: 22, lineHeight: 28 },
  hidden: { height: 0, opacity: 0 },
  search: {
    minHeight: ITEM_CONTROL_PT,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 15,
    gap: 10,
  },
  searchGlyph: { color: MUTED, fontSize: 18 },
  searchInput: { flex: 1, minHeight: ITEM_TARGET_MIN_PT, color: TITLE, fontSize: 14 },
  filters: { flexDirection: "row", gap: 8 },
  filter: {
    minHeight: 38,
    minWidth: ITEM_TARGET_MIN_PT,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 16,
    justifyContent: "center",
  },
  filterSelected: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  filterLabel: { color: MUTED, fontSize: 13, fontWeight: "600" },
  filterLabelSelected: { color: "#FFFFFF" },
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
  warn: {
    backgroundColor: "#FFF3D1",
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 15,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: "row",
    gap: 10,
  },
  warnMark: { color: TITLE, fontSize: 15, fontWeight: "700" },
  warnBody: { flex: 1, color: TITLE, fontSize: 12, lineHeight: 17, fontWeight: "500" },
  card: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 15,
    gap: 10,
    minHeight: ITEM_TARGET_MIN_PT,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { flex: 1, color: TITLE, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  chevron: { color: MUTED, fontSize: 24, lineHeight: 28 },
  badge: {
    alignSelf: "flex-start",
    backgroundColor: "#FFF3D1",
    color: TITLE,
    fontSize: 12,
    fontWeight: "600",
    overflow: "hidden",
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 4,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    backgroundColor: colors.background,
    color: MUTED,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    overflow: "hidden",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  panel: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 22,
    paddingHorizontal: 20,
    paddingVertical: 28,
    alignItems: "center",
    gap: 14,
  },
  mark: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: INFO,
    alignItems: "center",
    justifyContent: "center",
  },
  glyph: { color: PRIMARY, fontSize: 28 },
  panelTitle: { color: TITLE, fontSize: 19, lineHeight: 26, fontWeight: "700", textAlign: "center" },
  panelBody: { color: MUTED, fontSize: 13, lineHeight: 19, textAlign: "center" },
  outline: {
    minHeight: ITEM_PRIMARY_PT,
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  outlineLabel: { color: PRIMARY, fontSize: 16, fontWeight: "600" },
  error: { color: "#B8373E", fontSize: 14, textAlign: "center" },
  skeleton: {
    height: 105,
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: LINE,
    marginBottom: 10,
  },
  more: { color: MUTED, fontSize: 11, lineHeight: 15 },
});
