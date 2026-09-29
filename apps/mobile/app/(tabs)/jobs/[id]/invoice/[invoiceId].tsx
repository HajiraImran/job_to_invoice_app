import { formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../../../../src/i18n/en.ts";
import {
  canRecordRefund,
  canReverseLedgerEntry,
  canVoidInvoice,
  invoiceDeliveryPhase,
  invoiceDetailActionVisibility,
  invoiceDetailActivity,
  invoiceDetailAfterRefresh,
  invoiceDetailAnalytics,
  invoiceDetailBadge,
  invoiceDetailLoadKind,
  invoiceDetailRecipient,
  invoiceDetailTotalCents,
  invoiceDetailVisible,
  invoicePdfPhase,
  invoicePdfPollContinues,
  presentInvoiceStatus,
  type IssuedInvoiceRecord,
} from "../../../../../src/invoices/presentation.ts";
import { normalizePermittedActions } from "../../../../../src/jobs/presentation.ts";
import {
  jobCreditPath,
  jobDetailPath,
  jobInvoiceReplacePath,
  jobInvoiceVoidPath,
  jobLedgerEntryPath,
  jobLedgerReversePath,
} from "../../../../../src/jobs/routes.ts";
import { useAuth } from "../../../../../src/session/AuthProvider.tsx";
import { colors, type } from "../../../../../src/theme.ts";

const PRIMARY = "#464B71";
const PRIMARY_PRESSED = "#3A3E5E";
const GUTTER = 20;
const PDF_POLL_MS = 3000;
const PDF_POLL_LIMIT = 20;

type ScreenError = { message: string; status: number; code?: string; retryable: boolean };

export default function InvoiceDetailScreen() {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[]; invoiceId?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  const invoiceId =
    typeof params.invoiceId === "string" ? params.invoiceId : Array.isArray(params.invoiceId) ? (params.invoiceId[0] ?? "") : "";
  const [invoice, setInvoice] = useState<IssuedInvoiceRecord | undefined>();
  const [permitted, setPermitted] = useState<string[] | undefined>();
  const [pdfState, setPdfState] = useState<string | undefined>();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingPdf, setCheckingPdf] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>();
  const invoiceRef = useRef<IssuedInvoiceRecord | undefined>(undefined);
  const navigating = useRef(false);

  const leaveToJob = useCallback(() => {
    setActionsOpen(false);
    router.replace(jobDetailPath(jobId));
  }, [jobId, router]);

  const loadPdf = useCallback(async () => {
    if (!invoiceId || auth.snapshot.status === "access_expired") {
      return;
    }
    setCheckingPdf(true);
    const result = await runOwnerRequest<{ state: string; url: string | null }>({
      path: `/v1/documents/${invoiceId}/download`,
    });
    if (result.ok) {
      setPdfState(result.data.state);
      setPdfUrl(result.data.state === "ready" && result.data.url ? result.data.url : null);
    }
    setCheckingPdf(false);
  }, [auth.snapshot.status, invoiceId, runOwnerRequest]);

  const load = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, status: 404, retryable: false });
      return;
    }
    const hadInvoice = invoiceRef.current !== undefined;
    if (!hadInvoice) {
      setLoading(true);
    }
    const result = await runOwnerRequest<IssuedInvoiceRecord>({ path: `/v1/documents/${invoiceId}` });
    const next = invoiceDetailAfterRefresh(invoiceRef.current, result.ok ? result.data : undefined, result.ok);
    const kind = result.ok ? undefined : invoiceDetailLoadKind(result.error.status, result.error.code);
    if (!result.ok && (kind === "not_found" || kind === "unauthorized")) {
      invoiceRef.current = undefined;
      setInvoice(undefined);
    } else {
      invoiceRef.current = next;
      setInvoice(next);
    }
    if (result.ok) {
      setPdfState(result.data.pdf_state);
      setError(undefined);
    } else {
      setError({
        message:
          kind === "not_found"
            ? copy.jobNotFound
            : kind === "unauthorized"
              ? copy.invoiceDetailUnavailable
              : result.error.message || copy.invoiceIssueError,
        status: result.error.status,
        code: result.error.code,
        retryable: result.error.retryable || result.error.status === 0,
      });
    }
    if (jobId && result.ok) {
      const job = await runOwnerRequest<{ permitted_actions?: string[] }>({ path: `/v1/jobs/${jobId}` });
      if (job.ok) {
        setPermitted(normalizePermittedActions(job.data.permitted_actions));
      }
    }
    setLoading(false);
  }, [invoiceId, jobId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      if (auth.snapshot.status === "access_expired") {
        return;
      }
      void load();
      void loadPdf();
    }, [auth.snapshot.status, load, loadPdf]),
  );

  useEffect(() => {
    if (auth.snapshot.status !== "access_expired") {
      return;
    }
    invoiceRef.current = undefined;
    setInvoice(undefined);
    setPermitted(undefined);
    setPdfUrl(null);
    setPdfState(undefined);
    setActionsOpen(false);
  }, [auth.snapshot.status]);

  useEffect(() => {
    if (!actionsOpen) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setActionsOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [actionsOpen]);

  useEffect(() => {
    if (!invoicePdfPollContinues(pdfState, 0, PDF_POLL_LIMIT)) {
      return;
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (!invoicePdfPollContinues(pdfState, ticks, PDF_POLL_LIMIT)) {
        clearInterval(timer);
        return;
      }
      void loadPdf();
    }, PDF_POLL_MS);
    return () => clearInterval(timer);
  }, [pdfState, loadPdf]);

  const visible = invoiceDetailVisible(auth.snapshot.status, invoice);
  const offline = auth.snapshot.status === "offline_cached";
  const voided = Boolean(visible && (visible.voided || visible.lifecycle === "voided"));
  const phase = invoicePdfPhase(pdfState ?? visible?.pdf_state);
  const delivery = invoiceDeliveryPhase(visible?.delivery_state);
  const badge = invoiceDetailBadge({ lifecycle: visible?.lifecycle, voided, deliveryState: visible?.delivery_state });
  const totalCents = visible ? invoiceDetailTotalCents(visible.total_cents) : undefined;
  const recipient = invoiceDetailRecipient(visible?.snapshot.customer.email);
  const actions = invoiceDetailActionVisibility({
    offline,
    accessExpired: auth.snapshot.status === "access_expired",
    voided,
    canVoid: visible ? canVoidInvoice(visible) : false,
    canReplace: Boolean(permitted?.includes("create_replacement")),
    pdfReady: phase === "ready" && Boolean(pdfUrl),
  });
  const activity = invoiceDetailActivity({ issuedAt: visible?.issued_at, voided });
  const paymentLabel =
    visible && !voided && visible.payment_status && visible.payment_status !== "issued_unpaid"
      ? presentInvoiceStatus(visible.payment_status, false)
      : undefined;
  const loadKind = error ? invoiceDetailLoadKind(error.status, error.code) : undefined;

  function openOnce(path: string) {
    if (navigating.current || offline) {
      return;
    }
    navigating.current = true;
    setActionsOpen(false);
    router.push(path);
    navigating.current = false;
  }

  function openPdf() {
    if (!actions.viewPdf || !pdfUrl || offline) {
      return;
    }
    invoiceDetailAnalytics();
    void Linking.openURL(pdfUrl);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.headerRow}>
          <Pressable accessibilityLabel={copy.back} accessibilityRole="button" onPress={leaveToJob} style={styles.iconButton}>
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={copy.invoiceDetailActions}
            accessibilityRole="button"
            onPress={() => setActionsOpen(true)}
            style={styles.iconButton}
          >
            <Text style={styles.moreGlyph}>•••</Text>
          </Pressable>
        </View>
        <Text style={styles.eyebrow}>{copy.invoiceDetailEyebrow}</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {visible?.number ? `${copy.invoiceDetailName} ${visible.number}` : copy.invoiceIssueTitle}
        </Text>
        {visible ? (
          <Text accessibilityLiveRegion="polite" style={[styles.badge, badge === "voided" ? styles.badgeVoid : badge === "delivery_failed" ? styles.badgeFailed : styles.badgeIssued]}>
            {badge === "voided" ? copy.invoiceStatusVoided : badge === "delivery_failed" ? copy.invoiceDetailDeliveryFailed : copy.invoiceDetailIssued}
          </Text>
        ) : null}
        {visible?.issued_at && !voided ? <Text style={styles.meta}>{visible.issued_at}</Text> : null}
        {paymentLabel ? <Text style={styles.meta}>{paymentLabel}</Text> : null}
        {loading && !visible ? (
          <View accessibilityLabel={copy.requestLoading} style={styles.skeleton}>
            <ActivityIndicator color={PRIMARY} />
          </View>
        ) : null}
        {auth.snapshot.status === "access_expired" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.accessExpired}
          </Text>
        ) : null}
        {offline && visible ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.invoiceDetailOffline}
          </Text>
        ) : null}
        {error && loadKind !== "not_found" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error.message}
          </Text>
        ) : null}
        {loadKind === "not_found" ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {copy.jobNotFound}
          </Text>
        ) : null}
        {error?.retryable && !visible ? (
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{copy.retry}</Text>
          </Pressable>
        ) : null}
        {visible && totalCents !== undefined ? (
          <>
            <View style={styles.card}>
              {visible.snapshot.customer.name ? (
                <>
                  <Text style={styles.cardLabel}>{copy.invoiceDetailCustomer}</Text>
                  <Text style={styles.customer}>{visible.snapshot.customer.name}</Text>
                </>
              ) : null}
              {recipient ? <Text style={styles.meta}>{recipient}</Text> : null}
              <View style={styles.divider} />
              <View style={styles.totalRow}>
                <Text style={styles.cardLabel}>{copy.invoiceDetailTotalDue}</Text>
                <Text accessibilityLabel={`${copy.invoiceDetailTotalDue} ${formatUsdCents(totalCents)}`} style={styles.total}>
                  {formatUsdCents(totalCents)}
                </Text>
              </View>
            </View>
            {badge === "delivery_failed" ? (
              <View style={styles.noticeWarn}>
                <Text style={styles.noticeWarnTitle}>{copy.invoiceDetailDeliveryFailedTitle}</Text>
                <Text style={styles.noticeBody}>{copy.invoiceDetailDeliveryFailedBody}</Text>
              </View>
            ) : null}
            {voided ? (
              <View style={styles.noticeVoid}>
                <Text style={styles.noticeVoidTitle}>{copy.invoiceDetailVoidedNotice}</Text>
                <Text style={styles.noticeBody}>{copy.invoiceDetailVoidedBody}</Text>
              </View>
            ) : null}
            <View style={phase === "failed" ? styles.noticeWarn : styles.notice}>
              <Text style={phase === "failed" ? styles.noticeWarnTitle : styles.noticeTitle}>
                {phase === "ready" ? copy.invoiceDetailPdfReady : phase === "failed" ? copy.invoiceDetailPdfFailedTitle : copy.invoiceDetailPdfPreparing}
              </Text>
              <Text style={styles.noticeBody}>
                {phase === "ready" ? copy.invoiceDetailPdfReadyBody : phase === "failed" ? copy.invoiceDetailPdfFailedBody : copy.invoiceDetailPdfPreparingBody}
              </Text>
            </View>
            {delivery && delivery !== "not_requested" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {delivery === "failed"
                    ? copy.invoiceDetailDeliveryFailed
                    : delivery === "delivered"
                      ? copy.invoiceDetailDeliveryDelivered
                      : delivery === "accepted"
                        ? copy.invoiceDetailDeliveryAccepted
                        : copy.invoiceDetailDeliveryQueuedTitle}
                </Text>
                {delivery === "queued" ? <Text style={styles.noticeBody}>{copy.invoiceDetailDeliveryQueuedBody}</Text> : null}
              </View>
            ) : null}
            {voided ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{copy.invoiceDetailReplacement}</Text>
                <Text style={styles.noticeBody}>{copy.invoiceDetailReplacementBody}</Text>
              </View>
            ) : null}
            {activity.length > 0 ? (
              <>
                <Text style={styles.section}>{copy.invoiceDetailActivity}</Text>
                {activity.map((item, index) => (
                  <View key={item.key} style={styles.activityRow}>
                    <View style={styles.timeline}>
                      <View style={[styles.dot, index === 0 ? styles.dotActive : null]} />
                      {index < activity.length - 1 ? <View style={styles.line} /> : null}
                    </View>
                    <View>
                      <Text style={styles.activityTitle}>{item.key === "voided" ? copy.invoiceDetailVoidedTitle : copy.invoiceDetailCreated}</Text>
                      {item.at ? <Text style={styles.meta}>{item.at}</Text> : null}
                    </View>
                  </View>
                ))}
              </>
            ) : null}
            {(visible.entries ?? []).length > 0 ? (
              <>
                <Text style={styles.section}>{copy.invoiceLedger}</Text>
                <Text style={styles.meta}>{copy.ledgerRecordedBy}</Text>
                {(visible.entries ?? []).map((entry) => (
                  <View key={entry.id} style={styles.ledgerRow}>
                    <Text style={styles.activityTitle}>
                      {entry.effective_date} · {entry.type} · {formatUsdCents(entry.amount_cents)}
                    </Text>
                    {canReverseLedgerEntry(entry, visible.entries ?? []) && !offline ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => openOnce(jobLedgerReversePath(jobId, invoiceId, entry.id))}
                        style={styles.secondary}
                      >
                        <Text style={styles.secondaryLabel}>{copy.ledgerReverse}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </>
            ) : null}
            {phase !== "ready" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: checkingPdf || offline, busy: checkingPdf }}
                disabled={checkingPdf || offline}
                onPress={() => void loadPdf()}
                style={({ pressed }) => [styles.primary, pressed ? styles.primaryPressed : null, offline ? styles.disabled : null]}
              >
                <Text style={styles.primaryLabel}>{copy.invoiceCheckAgain}</Text>
              </Pressable>
            ) : null}
            {voided && actions.createReplacement ? (
              <Pressable accessibilityRole="button" onPress={() => openOnce(jobInvoiceReplacePath(jobId, invoiceId))} style={styles.primary}>
                <Text style={styles.primaryLabel}>{copy.invoiceReplace}</Text>
              </Pressable>
            ) : null}
            {actions.viewPdf ? (
              <Pressable
                accessibilityRole="button"
                onPress={openPdf}
                style={voided || badge === "delivery_failed" ? styles.secondary : styles.primary}
              >
                <Text style={voided || badge === "delivery_failed" ? styles.secondaryLabel : styles.primaryLabel}>{copy.invoiceDetailViewPdf}</Text>
              </Pressable>
            ) : null}
            {voided ? (
              <Pressable accessibilityRole="button" onPress={leaveToJob} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.invoiceBackToJob}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <Modal accessibilityViewIsModal animationType="slide" onRequestClose={() => setActionsOpen(false)} transparent visible={actionsOpen && Boolean(visible)}>
        <View style={styles.sheetWrap}>
          <Pressable accessibilityLabel={copy.requestCancel} onPress={() => setActionsOpen(false)} style={styles.scrim} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.handle} />
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {copy.invoiceDetailActions}
            </Text>
            <Text style={styles.noticeBody}>{copy.invoiceDetailActionsBody}</Text>
            {actions.viewPdf ? (
              <Pressable accessibilityRole="button" onPress={openPdf} style={styles.actionInfo}>
                <Text style={styles.actionInfoTitle}>{copy.invoiceDetailViewPdf}</Text>
                <Text style={styles.actionHint}>{copy.invoiceDetailPdfReadyBody}</Text>
              </Pressable>
            ) : null}
            {!voided && !offline && (visible?.amount_due_cents ?? 0) > 0 ? (
              <Pressable accessibilityRole="button" onPress={() => openOnce(jobLedgerEntryPath(jobId, invoiceId, "payment", true))} style={styles.actionInfo}>
                <Text style={styles.actionInfoTitle}>{copy.invoiceMarkPaid}</Text>
                <Text style={styles.actionHint}>{copy.ledgerWarning}</Text>
              </Pressable>
            ) : null}
            {!voided && !offline ? (
              <Pressable accessibilityRole="button" onPress={() => openOnce(jobLedgerEntryPath(jobId, invoiceId, "payment"))} style={styles.actionInfo}>
                <Text style={styles.actionInfoTitle}>{copy.invoiceRecordPayment}</Text>
                <Text style={styles.actionHint}>{copy.ledgerWarning}</Text>
              </Pressable>
            ) : null}
            {visible && !voided && !offline && canRecordRefund(visible.payment_status, visible.amount_to_refund_cents ?? 0) ? (
              <Pressable accessibilityRole="button" onPress={() => openOnce(jobLedgerEntryPath(jobId, invoiceId, "refund"))} style={styles.actionInfo}>
                <Text style={styles.actionInfoTitle}>{copy.invoiceRecordRefund}</Text>
                <Text style={styles.actionHint}>{copy.ledgerRefundWarning}</Text>
              </Pressable>
            ) : null}
            {!voided && !offline ? (
              <Pressable accessibilityRole="button" onPress={() => openOnce(jobCreditPath(jobId, invoiceId))} style={styles.actionInfo}>
                <Text style={styles.actionInfoTitle}>{copy.invoiceCredit}</Text>
                <Text style={styles.actionHint}>{copy.creditNoRefund}</Text>
              </Pressable>
            ) : null}
            {actions.voidInvoice ? (
              <Pressable accessibilityRole="button" onPress={() => openOnce(jobInvoiceVoidPath(jobId, invoiceId))} style={styles.actionDanger}>
                <Text style={styles.actionDangerTitle}>{copy.invoiceVoid}</Text>
                <Text style={styles.actionHint}>{copy.invoiceDetailVoidBody}</Text>
              </Pressable>
            ) : null}
            {actions.createReplacement ? (
              <Pressable accessibilityRole="button" onPress={() => openOnce(jobInvoiceReplacePath(jobId, invoiceId))} style={styles.actionInfo}>
                <Text style={styles.actionInfoTitle}>{copy.invoiceReplace}</Text>
                <Text style={styles.actionHint}>{copy.invoiceDetailReplacementBody}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => setActionsOpen(false)} style={styles.secondary}>
              <Text style={styles.secondaryLabel}>{copy.requestCancel}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
    backgroundColor: "#E8F1FF",
    opacity: 0.62,
  },
  content: { paddingHorizontal: GUTTER, gap: 12 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "#DADFE8",
    alignItems: "center",
    justifyContent: "center",
  },
  backGlyph: { color: "#181F30", fontSize: 28, lineHeight: 32 },
  moreGlyph: { color: "#181F30", fontSize: 16, fontWeight: "700", letterSpacing: 1 },
  eyebrow: { color: PRIMARY, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  title: { color: "#181F30", fontSize: 27, lineHeight: 34, fontWeight: "700" },
  badge: { alignSelf: "flex-start", overflow: "hidden", borderRadius: 99, paddingHorizontal: 10, paddingVertical: 6, fontSize: 11, fontWeight: "700" },
  badgeIssued: { backgroundColor: "#E6F9F4", color: "#1BB99A" },
  badgeFailed: { backgroundColor: "#FFECED", color: "#B8373E" },
  badgeVoid: { backgroundColor: "#FFF7E0", color: "#AD700F" },
  meta: { color: "#5B6577", fontSize: 12, lineHeight: 18 },
  skeleton: { minHeight: 140, alignItems: "center", justifyContent: "center" },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  card: { backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: "#DADFE8", padding: 16, gap: 6 },
  cardLabel: { color: "#5B6577", fontSize: 11, fontWeight: "700", letterSpacing: 0.6 },
  cardTitle: { color: "#181F30", fontSize: 14, fontWeight: "700" },
  customer: { color: "#181F30", fontSize: 15, fontWeight: "600" },
  divider: { height: 1, backgroundColor: "#DADFE8", marginVertical: 8 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  total: { color: PRIMARY, fontSize: 22, fontWeight: "700" },
  notice: { backgroundColor: "#E8F1FF", borderRadius: 17, padding: 16, gap: 4 },
  noticeTitle: { color: "#3874CB", fontSize: 14, fontWeight: "700" },
  noticeBody: { color: "#5B6577", fontSize: 12, lineHeight: 18 },
  noticeWarn: { backgroundColor: "#FFECED", borderRadius: 17, padding: 16, gap: 4 },
  noticeWarnTitle: { color: "#B8373E", fontSize: 14, fontWeight: "700" },
  noticeVoid: { backgroundColor: "#FFF7E0", borderRadius: 17, padding: 16, gap: 4 },
  noticeVoidTitle: { color: "#AD700F", fontSize: 14, fontWeight: "700" },
  section: { color: "#181F30", fontSize: 17, fontWeight: "700", marginTop: 4 },
  activityRow: { flexDirection: "row", gap: 12 },
  timeline: { width: 12, alignItems: "center" },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#DADFE8", marginTop: 6 },
  dotActive: { backgroundColor: PRIMARY },
  line: { width: 2, flex: 1, backgroundColor: "#DADFE8", marginTop: 2 },
  activityTitle: { color: "#181F30", fontSize: 13, fontWeight: "600" },
  ledgerRow: { gap: 8 },
  primary: { minHeight: 56, borderRadius: 18, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  primaryPressed: { backgroundColor: PRIMARY_PRESSED },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  secondary: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "#DADFE8",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: { color: PRIMARY, fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(19,25,39,0.4)" },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: GUTTER, paddingTop: 12, gap: 10 },
  handle: { alignSelf: "center", width: 42, height: 4, borderRadius: 2, backgroundColor: "#DADFE8" },
  sheetTitle: { color: "#181F30", fontSize: 22, fontWeight: "700" },
  actionInfo: { backgroundColor: "#E8F1FF", borderRadius: 16, padding: 14, gap: 2 },
  actionInfoTitle: { color: "#3874CB", fontSize: 14, fontWeight: "700" },
  actionDanger: { backgroundColor: "#FFECED", borderRadius: 16, padding: 14, gap: 2 },
  actionDangerTitle: { color: "#B8373E", fontSize: 14, fontWeight: "700" },
  actionHint: { color: "#5B6577", fontSize: 11, lineHeight: 16 },
});
