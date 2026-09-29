import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  BackHandler,
  findNodeHandle,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../../src/crypto/uuid.ts";
import {
  CUSTOMER_PRIMARY_MIN_PT,
  CUSTOMER_TARGET_MIN_PT,
  customerActionSheet,
  customerAnalyticsProperties,
  customerArchiveBody,
  customerDetailVisible,
  customerHardwareBack,
  customerIdempotencyAfterFailure,
  customerJobSummary,
  customerJobsPath,
  customerMutationAllowed,
  formatBillingAddress,
  type CustomerRecord,
} from "../../../../src/customers/presentation.ts";
import { copy } from "../../../../src/i18n/en.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors } from "../../../../src/theme.ts";

const PRIMARY = "#464B71";
const GUTTER = 18;

type JobRow = { id: string; title: string; lifecycle: string };

export default function CustomerDetailScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const authStatus = auth.snapshot.status;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const customerId = typeof params.id === "string" ? params.id : "";
  const [customer, setCustomer] = useState<CustomerRecord | undefined>();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobsCursor, setJobsCursor] = useState<string | null>(null);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobsError, setJobsError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [referencedOverride, setReferencedOverride] = useState(false);
  const [missing, setMissing] = useState(false);
  const inFlight = useRef(false);
  const idempotency = useRef<string | undefined>(undefined);
  const hasCustomer = useRef(false);
  const moreRef = useRef<View>(null);
  const visible = customerDetailVisible(authStatus, customer);
  const referenced = referencedOverride || jobs.length > 0 || Boolean(jobsCursor);
  const actions = customerActionSheet({
    archived: Boolean(visible?.archived_at),
    jobsLoaded: jobsLoaded || referencedOverride,
    referenced,
  });

  const load = useCallback(async () => {
    if (authStatus === "access_expired" || authStatus === "offline_cached" || !customerId) {
      hasCustomer.current = false;
      setCustomer(undefined);
      setJobs([]);
      setJobsCursor(null);
      setJobsLoaded(false);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (authStatus !== "authenticated") {
      setLoading(false);
      return;
    }
    setRefreshing(hasCustomer.current);
    setLoading(!hasCustomer.current);
    setMessage(undefined);
    setMissing(false);
    const [customerResult, jobResult] = await Promise.all([
      runOwnerRequest<CustomerRecord>({ path: `/v1/customers/${customerId}` }),
      runOwnerRequest<{ items: JobRow[]; next_cursor: string | null }>({
        path: customerJobsPath(customerId),
      }),
    ]);
    setLoading(false);
    setRefreshing(false);
    if (!customerResult.ok) {
      if (customerResult.error.code === "NOT_FOUND" || customerResult.error.status === 404) {
        hasCustomer.current = false;
        setCustomer(undefined);
        setJobs([]);
        setMissing(true);
        setMessage(copy.customerNotFound);
        return;
      }
      setMessage(customerResult.error.message || copy.customersLoadError);
      return;
    }
    hasCustomer.current = true;
    setCustomer(customerResult.data);
    if (!jobResult.ok) {
      setJobsError(jobResult.error.message || copy.customersLoadError);
      setJobsLoaded(false);
      return;
    }
    setJobs(jobResult.data.items);
    setJobsCursor(jobResult.data.next_cursor);
    setJobsLoaded(true);
    setJobsError(undefined);
    customerAnalyticsProperties();
  }, [authStatus, customerId, runOwnerRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeSheet = useCallback(() => {
    setSheet(false);
    requestAnimationFrame(() => {
      const node = findNodeHandle(moreRef.current);
      if (node) {
        AccessibilityInfo.setAccessibilityFocus(node);
      }
    });
  }, []);

  const goBack = useCallback(() => {
    if (customerHardwareBack(sheet) === "close_sheet") {
      closeSheet();
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/customers");
  }, [closeSheet, router, sheet]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [goBack]);

  async function mutate(path: string, method: "POST" | "DELETE", body?: { archived: boolean }) {
    if (!customerMutationAllowed(inFlight.current, authStatus)) {
      setMessage(authStatus === "access_expired" ? copy.accessExpired : copy.customersOffline);
      return;
    }
    inFlight.current = true;
    const key = idempotency.current ?? secureRandomUUID();
    idempotency.current = key;
    const result = await runOwnerRequest<CustomerRecord & { deleted?: boolean }>({
      path,
      method,
      body,
      idempotencyKey: key,
    });
    inFlight.current = false;
    if (!result.ok) {
      idempotency.current = customerIdempotencyAfterFailure(key, result.error.code);
      if (result.error.code === "CUSTOMER_REFERENCED") {
        setReferencedOverride(true);
        setMessage(copy.customerDeleteUnavailable);
        setSheet(true);
        return;
      }
      setMessage(result.error.code === "VERSION_CONFLICT" ? copy.customerVersionConflict : result.error.message || copy.customersLoadError);
      return;
    }
    idempotency.current = undefined;
    if (method === "DELETE") {
      router.replace("/customers");
      return;
    }
    setCustomer(result.data);
    setSheet(false);
    setMessage(undefined);
  }

  function confirmArchive(archived: boolean) {
    Alert.alert(
      archived ? copy.customerArchiveTitle : copy.customerRestoreTitle,
      archived ? copy.customerArchiveConfirm : copy.customerRestoreConfirm,
      [
        { text: copy.customerCancel, style: "cancel" },
        {
          text: archived ? copy.customerArchive : copy.customerRestore,
          onPress: () => void mutate(`/v1/customers/${customerId}/archive`, "POST", customerArchiveBody(archived)),
        },
      ],
    );
  }

  function confirmDelete() {
    Alert.alert(copy.customerDeleteTitle, copy.customerDeleteConfirm, [
      { text: copy.customerCancel, style: "cancel" },
      {
        text: copy.customerDelete,
        style: "destructive",
        onPress: () => void mutate(`/v1/customers/${customerId}`, "DELETE"),
      },
    ]);
  }

  const address = visible ? formatBillingAddress(visible.billing_address) : "";
  const jobTotal = jobsLoaded && !jobsCursor ? copy.customerJobsTotal.replace("{count}", String(jobs.length)) : undefined;

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
        <Pressable accessibilityLabel={copy.back} accessibilityRole="button" onPress={goBack} style={styles.back}>
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
        {authStatus === "offline_cached" ? (
          <Text accessibilityLiveRegion="polite" style={styles.note}>
            {copy.customersUnavailable}
          </Text>
        ) : null}
        {authStatus === "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.note}>
            {copy.accessExpired}
          </Text>
        ) : null}
        {loading && !visible ? <ActivityIndicator accessibilityLabel={copy.customersLoading} color={PRIMARY} /> : null}
        {refreshing ? <ActivityIndicator accessibilityLabel={copy.customersLoading} color={PRIMARY} /> : null}
        {message ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {message}
          </Text>
        ) : null}
        {missing ? (
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{copy.customersRetry}</Text>
          </Pressable>
        ) : null}
        {visible ? (
          <>
            <View style={styles.titleRow}>
              <View style={styles.titleCopy}>
                <Text style={styles.eyebrow}>{copy.customerEyebrow}</Text>
                <Text accessibilityRole="header" style={styles.title}>
                  {visible.name}
                </Text>
              </View>
              <Pressable
                ref={moreRef}
                accessibilityLabel={copy.customerMore}
                accessibilityRole="button"
                onPress={() => setSheet(true)}
                style={styles.more}
              >
                <Text style={styles.moreLabel}>•••</Text>
              </Pressable>
            </View>
            <View style={visible.archived_at ? styles.badgeArchived : styles.badgeActive}>
              <Text style={visible.archived_at ? styles.badgeArchivedLabel : styles.badgeActiveLabel}>
                {visible.archived_at ? copy.customerStatusArchived : copy.customerActive}
              </Text>
            </View>
            {visible.archived_at && referenced ? (
              <View style={styles.notice}>
                <Text style={styles.noticeTitle}>{copy.customerKeptHistory}</Text>
                <Text style={styles.noticeBody}>{copy.customerKeptBody}</Text>
              </View>
            ) : null}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{copy.customerContact}</Text>
              {visible.email ? <ContactRow label={copy.customerEmailLabel} value={visible.email} /> : null}
              {visible.phone ? <ContactRow label={copy.customerPhoneLabel} value={visible.phone} /> : null}
              {address ? <ContactRow label={copy.customerBillingLabel} value={address} /> : null}
            </View>
            <View style={styles.jobsHeader}>
              <Text accessibilityRole="header" style={styles.section}>
                {copy.customerJobs}
              </Text>
              {jobTotal ? <Text style={styles.jobTotal}>{jobTotal}</Text> : null}
            </View>
            {jobsError ? (
              <View>
                <Text accessibilityLiveRegion="polite" style={styles.error}>
                  {jobsError}
                </Text>
                <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.retry}>
                  <Text style={styles.retryLabel}>{copy.customersRetry}</Text>
                </Pressable>
              </View>
            ) : null}
            {jobsLoaded && jobs.length === 0 ? <Text style={styles.note}>{copy.customerJobsEmpty}</Text> : null}
            {jobs.map((job) => {
              const summary = customerJobSummary(job);
              return (
                <Pressable
                  accessibilityRole="button"
                  key={summary.id}
                  onPress={() => router.push(`/(tabs)/jobs/${summary.id}`)}
                  style={styles.job}
                >
                  <View style={styles.jobCopy}>
                    <Text style={styles.jobTitle}>{summary.title}</Text>
                    <Text style={styles.jobState}>{summary.status}</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              );
            })}
            {jobsCursor ? (
              <Pressable accessibilityRole="button" onPress={() => void loadMoreJobs(jobsCursor)} style={styles.retry}>
                <Text style={styles.retryLabel}>{copy.customersShowingNewest}</Text>
              </Pressable>
            ) : null}
            {authStatus === "authenticated" && !visible.archived_at ? (
              <>
                <Pressable accessibilityRole="button" onPress={() => router.push(`/customers/${customerId}/edit`)} style={styles.primary}>
                  <Text style={styles.primaryLabel}>{copy.customerEdit}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: inFlight.current }}
                  onPress={() => confirmArchive(true)}
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.customerArchive}</Text>
                </Pressable>
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <Modal animationType="slide" onRequestClose={closeSheet} transparent visible={sheet}>
        <Pressable accessibilityLabel={copy.customerCancel} onPress={closeSheet} style={styles.scrim}>
          <Pressable
            accessibilityLabel={copy.customerActions}
            accessibilityViewIsModal
            onPress={() => undefined}
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
          >
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>{copy.customerActions}</Text>
            {actions.actions.includes("edit") ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  closeSheet();
                  router.push(`/customers/${customerId}/edit`);
                }}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{copy.customerEdit}</Text>
              </Pressable>
            ) : null}
            {actions.actions.includes("archive") ? (
              <Pressable accessibilityRole="button" onPress={() => confirmArchive(true)} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.customerArchive}</Text>
              </Pressable>
            ) : null}
            {actions.actions.includes("restore") ? (
              <Pressable accessibilityRole="button" onPress={() => confirmArchive(false)} style={styles.primary}>
                <Text style={styles.primaryLabel}>{copy.customerRestore}</Text>
              </Pressable>
            ) : null}
            {actions.actions.includes("delete") ? (
              <Pressable accessibilityRole="button" onPress={confirmDelete} style={styles.danger}>
                <Text style={styles.dangerLabel}>{copy.customerDelete}</Text>
              </Pressable>
            ) : null}
            {actions.deleteUnavailable ? <Text style={styles.note}>{copy.customerDeleteUnavailable}</Text> : null}
            <Pressable accessibilityRole="button" onPress={closeSheet} style={styles.retry}>
              <Text style={styles.retryLabel}>{copy.customerCancel}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );

  async function loadMoreJobs(cursor: string) {
    if (authStatus !== "authenticated") {
      return;
    }
    const result = await runOwnerRequest<{ items: JobRow[]; next_cursor: string | null }>({
      path: customerJobsPath(customerId, cursor),
    });
    if (!result.ok) {
      setJobsError(result.error.message || copy.customersLoadError);
      return;
    }
    setJobs((current) => {
      const seen = new Set(current.map((job) => job.id));
      return [...current, ...result.data.items.filter((job) => !seen.has(job.id))];
    });
    setJobsCursor(result.data.next_cursor);
  }
}

function ContactRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.contactRow}>
      <Text style={styles.contactLabel}>{label}</Text>
      <Text style={styles.contactValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  atmosphere: {
    position: "absolute",
    top: -56,
    right: -40,
    width: 170,
    height: 170,
    borderRadius: 85,
    backgroundColor: "#E3EDFC",
  },
  content: { paddingHorizontal: GUTTER, gap: 12 },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6DEEB",
    alignItems: "center",
    justifyContent: "center",
  },
  backGlyph: { color: "#131829", fontSize: 28, lineHeight: 32 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  titleCopy: { flex: 1 },
  eyebrow: { color: PRIMARY, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  title: { color: "#131829", fontSize: 28, lineHeight: 34, fontWeight: "700", marginTop: 4 },
  more: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6DEEB",
    alignItems: "center",
    justifyContent: "center",
  },
  moreLabel: { color: PRIMARY, fontSize: 18, fontWeight: "700" },
  badgeActive: {
    alignSelf: "flex-start",
    minHeight: 28,
    borderRadius: 14,
    backgroundColor: "#DEF7F0",
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  badgeActiveLabel: { color: "#14A88C", fontSize: 11, fontWeight: "600" },
  badgeArchived: {
    alignSelf: "flex-start",
    minHeight: 28,
    borderRadius: 14,
    backgroundColor: "#FFF2D1",
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  badgeArchivedLabel: { color: PRIMARY, fontSize: 11, fontWeight: "600" },
  notice: { backgroundColor: "#FFF2D1", borderRadius: 16, padding: 14, gap: 4 },
  noticeTitle: { color: "#131829", fontSize: 14, fontWeight: "600" },
  noticeBody: { color: "#5C6680", fontSize: 12, lineHeight: 18 },
  card: { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#D6DEEB", borderRadius: 18, padding: 16, gap: 10 },
  cardTitle: { color: "#131829", fontSize: 15, fontWeight: "600" },
  contactRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  contactLabel: { width: 70, color: "#5C6680", fontSize: 10, fontWeight: "700", marginTop: 2 },
  contactValue: { flex: 1, color: "#131829", fontSize: 13, lineHeight: 18 },
  jobsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  section: { color: "#131829", fontSize: 20, fontWeight: "600", flex: 1 },
  jobTotal: { color: "#5C6680", fontSize: 12 },
  job: {
    minHeight: 76,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6DEEB",
    borderRadius: 15,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  jobCopy: { flex: 1, gap: 4 },
  jobTitle: { color: "#131829", fontSize: 14, fontWeight: "600" },
  jobState: { color: "#5C6680", fontSize: 12 },
  chevron: { color: "#5C6680", fontSize: 22 },
  note: { color: "#5C6680", fontSize: 13, lineHeight: 18, textAlign: "center" },
  error: { color: "#B8373E", fontSize: 14, lineHeight: 20 },
  primary: {
    minHeight: CUSTOMER_PRIMARY_MIN_PT,
    borderRadius: 16,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  secondary: {
    minHeight: CUSTOMER_PRIMARY_MIN_PT,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D6DEEB",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  secondaryLabel: { color: PRIMARY, fontSize: 16, fontWeight: "600" },
  danger: {
    minHeight: CUSTOMER_TARGET_MIN_PT,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerLabel: { color: "#B8373E", fontSize: 16, fontWeight: "600" },
  retry: { minHeight: CUSTOMER_TARGET_MIN_PT, justifyContent: "center", alignItems: "center" },
  retryLabel: { color: PRIMARY, fontSize: 16, fontWeight: "600" },
  scrim: { flex: 1, backgroundColor: "rgba(19, 24, 41, 0.28)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: GUTTER,
    paddingTop: 12,
    gap: 10,
  },
  handle: { alignSelf: "center", width: 56, height: 5, borderRadius: 3, backgroundColor: "#D6DEEB" },
  sheetTitle: { color: "#131829", fontSize: 18, fontWeight: "600", textAlign: "center" },
});
