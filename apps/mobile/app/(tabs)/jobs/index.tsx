import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../src/i18n/en.ts";
import { listStateFromFilter } from "../../../src/jobs/form.ts";
import { presentJobsList, type JobSummary } from "../../../src/jobs/presentation.ts";
import { upsertCachedJobs, listCachedJobs } from "../../../src/jobs/cache.ts";
import {
  applyCachedJobs,
  applyJobsFailure,
  applyNetworkJobs,
  beginJobsLoad,
  initialJobsListState,
  jobsListKey,
  type JobsListState,
} from "../../../src/jobs/list-state.ts";
import { createJobDisabled, createJobPath, jobDetailPath } from "../../../src/jobs/routes.ts";
import { canUseCachedCommercialData } from "../../../src/sync/offline-gate.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

type Filter = "active" | "finished" | "archived";

export default function JobsScreen() {
  const auth = useAuth();
  const { runOwnerRequest, getSyncSessionDb } = auth;
  const authStatus = auth.snapshot.status;
  const lastAuthenticatedAt = auth.snapshot.lastAuthenticatedAt;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>("active");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const listState = listStateFromFilter(filter);
  const key = jobsListKey(listState, search);
  const [state, setState] = useState<JobsListState>(() => initialJobsListState(key));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loadingMore, setLoadingMore] = useState(false);
  const focusedOnceRef = useRef(false);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const update = useCallback((next: (prev: JobsListState) => JobsListState) => {
    setState((prev) => {
      const value = next(prev);
      stateRef.current = value;
      return value;
    });
  }, []);

  const load = useCallback(async () => {
    const next = beginJobsLoad(stateRef.current, key);
    const generation = next.generation;
    update(() => next);
    const session = getSyncSessionDb();

    if (authStatus === "offline_cached") {
      if (!canUseCachedCommercialData(authStatus, lastAuthenticatedAt, Date.now())) {
        update((prev) => applyJobsFailure(prev, generation, { message: copy.accessExpired, retryable: false }));
        return;
      }
      if (!session) {
        update((prev) => applyJobsFailure(prev, generation, { message: copy.cacheMissOffline, retryable: true }));
        return;
      }
      try {
        const cached = await listCachedJobs(session.db, { listState, search });
        const items = cached.map((row) => JSON.parse(row.payloadJson) as JobSummary);
        update((prev) => applyNetworkJobs(prev, generation, { items, next_cursor: null }));
        if (items.length === 0) {
          update((prev) => applyJobsFailure(prev, generation, { message: copy.cacheMissOffline, retryable: true }));
        }
      } catch {
        update((prev) => applyJobsFailure(prev, generation, { message: copy.cacheMissOffline, retryable: true }));
      }
      return;
    }

    if (session && next.source === "none") {
      void listCachedJobs(session.db, { listState, search })
        .then((rows) => {
          const items = rows.map((row) => JSON.parse(row.payloadJson) as JobSummary);
          update((prev) => applyCachedJobs(prev, generation, items));
        })
        .catch(() => undefined);
    }

    const query = new URLSearchParams();
    query.set("state", listState);
    if (search) {
      query.set("search", search);
    }
    const result = await runOwnerRequest<{ items: JobSummary[]; next_cursor: string | null }>({
      path: `/v1/jobs?${query.toString()}`,
    });
    if (!result.ok) {
      update((prev) =>
        applyJobsFailure(prev, generation, {
          message: result.error.message || copy.jobLoadError,
          retryable: result.error.retryable || result.error.status === 0,
        }),
      );
      return;
    }
    update((prev) => applyNetworkJobs(prev, generation, result.data));
    if (session) {
      void upsertCachedJobs(
        session.db,
        result.data.items.map((job) => ({
          jobId: job.id,
          payloadJson: JSON.stringify(job),
          listState,
          syncBadge: "synced" as const,
          serverConfirmed: true,
        })),
      ).catch(() => undefined);
    }
  }, [authStatus, getSyncSessionDb, key, lastAuthenticatedAt, listState, runOwnerRequest, search, update]);

  const loadMore = useCallback(
    async (cursor: string) => {
      const generation = stateRef.current.generation;
      setLoadingMore(true);
      const query = new URLSearchParams();
      query.set("state", listState);
      if (search) {
        query.set("search", search);
      }
      query.set("cursor", cursor);
      const result = await runOwnerRequest<{ items: JobSummary[]; next_cursor: string | null }>({
        path: `/v1/jobs?${query.toString()}`,
      });
      setLoadingMore(false);
      if (stateRef.current.generation !== generation) {
        return;
      }
      if (result.ok) {
        update((prev) => applyNetworkJobs(prev, generation, result.data, true));
      } else {
        update((prev) =>
          applyJobsFailure(prev, generation, {
            message: result.error.message || copy.jobLoadError,
            retryable: result.error.retryable || result.error.status === 0,
          }),
        );
      }
    },
    [listState, runOwnerRequest, search, update],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      if (!focusedOnceRef.current) {
        focusedOnceRef.current = true;
        return;
      }
      if (!stateRef.current.loading) {
        void load();
      }
    }, [load]),
  );

  const { items, nextCursor, loading, loadedOnce, error } = state;
  const view = presentJobsList({
    authStatus,
    loading,
    loadedOnce,
    items,
    searching: search.length > 0,
    error,
  });
  const createDisabled = createJobDisabled(auth.snapshot.status, false);

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.jobsTitle}
      </Text>
      {view.showOfflineBanner ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.offlineCached}
        </Text>
      ) : null}
      {auth.snapshot.status === "access_expired" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.accessExpired}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: createDisabled }}
        disabled={createDisabled}
        onPress={() => router.push(createJobPath())}
        style={[styles.button, createDisabled ? styles.buttonDisabled : null]}
      >
        <Text style={styles.buttonLabel}>{copy.createJob}</Text>
      </Pressable>

      <TextInput
        accessibilityLabel={copy.jobSearch}
        onChangeText={setSearchInput}
        placeholder={copy.jobSearch}
        placeholderTextColor={colors.secondary}
        style={styles.search}
        value={searchInput}
      />
      {view.showSearchDownloaded ? (
        <Text style={styles.banner}>{copy.jobOfflineSearch}</Text>
      ) : null}

      <View accessibilityRole="tablist" style={styles.filters}>
        {(["active", "finished", "archived"] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === item }}
            onPress={() => setFilter(item)}
            style={[styles.filter, filter === item ? styles.filterSelected : null]}
          >
            <Text style={[styles.filterLabel, filter === item ? styles.filterLabelSelected : null]}>
              {item === "active"
                ? copy.jobFilterActive
                : item === "finished"
                  ? copy.jobFilterFinished
                  : copy.jobFilterArchived}
            </Text>
          </Pressable>
        ))}
      </View>

      {view.kind === "loading" ? (
        <View accessibilityLiveRegion="polite" style={styles.center}>
          <ActivityIndicator color={colors.navy} />
        </View>
      ) : null}

      {view.kind === "error" ? (
        <View style={styles.center}>
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {view.message ?? copy.jobLoadError}
          </Text>
          {view.showRetry ? (
            <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.retry}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {view.kind === "empty" && !error ? (
        <View style={styles.center}>
          <Text style={styles.empty}>{copy.jobsEmpty}</Text>
          <Text style={styles.hint}>{copy.jobsEmptyHint}</Text>
        </View>
      ) : null}

      {(view.kind === "empty" && error) || (view.kind === "offline" && view.items.length === 0) ? (
        <View style={styles.center}>
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error?.message ?? view.message ?? copy.cacheMissOffline}
          </Text>
          {view.showRetry ? (
            <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.retry}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {view.items.length > 0 ? (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {view.refreshing ? <ActivityIndicator accessibilityLabel={copy.refreshing} color={colors.navy} /> : null}
          {view.message ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.message}
            </Text>
          ) : null}
          {view.items.map((job) => (
            <Pressable
              key={job.id}
              accessibilityRole="button"
              accessibilityLabel={`${job.title}, ${job.customer_name}`}
              onPress={() => router.push(jobDetailPath(job.id))}
              style={styles.card}
            >
              <Text style={styles.cardTitle}>{job.title}</Text>
              <Text style={styles.cardMeta}>{job.customer_name}</Text>
              <Text style={styles.cardMeta}>{lifecycleLabel(job.lifecycle)}</Text>
            </Pressable>
          ))}
          {nextCursor && !loadingMore ? (
            <Pressable accessibilityRole="button" onPress={() => void loadMore(nextCursor)} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.loadMore}</Text>
            </Pressable>
          ) : null}
          {loadingMore ? <ActivityIndicator color={colors.navy} /> : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

function lifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case "active":
      return copy.jobLifecycleActive;
    case "invoiced":
      return copy.jobLifecycleInvoiced;
    case "finished":
      return copy.jobLifecycleFinished;
    case "canceled":
      return copy.jobLifecycleCanceled;
    case "archived":
      return copy.jobLifecycleArchived;
    default:
      return copy.jobLifecycleDraft;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700", marginTop: space.scale },
  banner: { color: colors.navy, fontSize: type.secondary },
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
