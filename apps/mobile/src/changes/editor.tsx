import { dollarsStringToCents, formatUsdCents } from "@job-to-invoice/schemas";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../crypto/uuid.ts";
import { copy } from "../i18n/en.ts";
import { jobDetailPath } from "../jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../setup/idempotency.ts";
import { useAuth } from "../session/AuthProvider.tsx";
import { colors, space, type } from "../theme.ts";
import {
  beginChangePreviewRequest,
  beginChangePublishRequest,
  changePreviewAfterFailure,
  changeRecipientPlan,
  presentChangeRecipient,
  extraWorkIdempotencyAfterFailure,
  presentBlockedChangePublish,
  presentChangeEditor,
  presentChangePreviewFailure,
  presentChangePublishResponse,
  type ChangeDraftRecord,
  type ChangePreviewRecord,
  type ChangePublishNotice,
} from "./presentation.ts";

type AdditionForm = {
  client_line_id: string;
  description: string;
  quantity: string;
  unit_price: string;
};

function centsToDollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents % 100)).padStart(2, "0");
  return `${whole}.${frac}`;
}

export function ChangeEditorScreen(props: { jobId: string; mode: "additions" | "reductions" }) {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<ChangeDraftRecord | undefined>();
  const [reason, setReason] = useState("");
  const [additions, setAdditions] = useState<AdditionForm[]>([]);
  const [credits, setCredits] = useState<Record<string, string>>({});
  const [recipient, setRecipient] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean; status: number; code?: string }>();
  const [preview, setPreview] = useState<ChangePreviewRecord | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [operationNotice, setOperationNotice] = useState<ChangePublishNotice | undefined>();
  const openKey = useRef<string | undefined>(undefined);
  const saveKey = useRef<string | undefined>(undefined);
  const publishKey = useRef<string | undefined>(undefined);
  const previewInFlight = useRef(false);
  const publishInFlight = useRef(false);
  const offline = auth.snapshot.status === "offline_cached";

  const applyDraft = useCallback((next: ChangeDraftRecord) => {
    setDraft(next);
    setReason(next.reason);
    setAdditions(
      next.additions.map((line) => ({
        client_line_id: line.client_line_id,
        description: line.description,
        quantity: line.quantity,
        unit_price: centsToDollars(line.unit_price_cents),
      })),
    );
    const nextCredits: Record<string, string> = {};
    for (const source of next.sources) {
      const existing = next.reductions.find((row) => row.source_line_id === source.source_line_id);
      nextCredits[source.source_line_id] = existing ? centsToDollars(existing.net_credit_cents) : "";
    }
    setCredits(nextCredits);
    if (!recipient && next.sources.length >= 0) {
      setRecipient("");
    }
  }, [recipient]);

  const load = useCallback(async () => {
    if (!props.jobId) {
      setLoading(false);
      setError({ message: copy.jobNotFound, retryable: false, status: 404 });
      return;
    }
    setLoading(true);
    setError(undefined);
    openKey.current = retainOrCreateSetupIdempotencyKey(openKey.current);
    const opened = await runOwnerRequest<ChangeDraftRecord>({
      path: `/v1/jobs/${props.jobId}/changes`,
      method: "POST",
      idempotencyKey: openKey.current,
    });
    if (!opened.ok) {
      setLoading(false);
      if (opened.error.code === "IDEMPOTENCY_MISMATCH") {
        openKey.current = retainOrCreateSetupIdempotencyKey(undefined);
      }
      setError({
        message: opened.error.message || copy.changeLoadError,
        retryable: opened.error.retryable || opened.error.status === 0,
        status: opened.error.status,
        code: opened.error.code,
      });
      return;
    }
    applyDraft(opened.data);
    setLoading(false);
  }, [applyDraft, props.jobId, runOwnerRequest]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  function payload() {
    return {
      reason,
      expected_scope_version: draft?.expected_scope_version ?? 1,
      expiry_days: draft?.expiry_days ?? 14,
      additions: additions
        .map((line) => {
          const price = dollarsStringToCents(line.unit_price);
          return {
            client_line_id: line.client_line_id,
            description: line.description,
            unit: "item" as const,
            custom_unit_label: null,
            quantity: line.quantity,
            unit_price_cents: price.ok ? price.value : 0,
            discount_cents: 0,
            tax_bp: draft?.default_tax_bp ?? 0,
          };
        })
        .filter((line) => line.description.trim().length > 0 && line.unit_price_cents > 0),
      reductions: Object.entries(credits)
        .map(([source_line_id, value]) => {
          const parsed = dollarsStringToCents(value);
          return parsed.ok && parsed.value > 0 ? { source_line_id, net_credit_cents: parsed.value } : undefined;
        })
        .filter((row): row is { source_line_id: string; net_credit_cents: number } => Boolean(row)),
    };
  }

  async function saveAndPreview() {
    if (!draft || offline || busy) {
      return;
    }
    const started = beginChangePreviewRequest({
      draftId: draft.id,
      version: draft.version,
      allowed: !offline,
      inFlight: previewInFlight,
    });
    if (started.kind === "ignored") {
      return;
    }
    setBusy(true);
    setError(undefined);
    setOperationNotice(undefined);
    try {
      saveKey.current = retainOrCreateSetupIdempotencyKey(saveKey.current);
      const saved = await runOwnerRequest<ChangeDraftRecord>({
        path: `/v1/drafts/${draft.id}`,
        method: "PATCH",
        idempotencyKey: saveKey.current,
        ifMatch: draft.version,
        body: payload(),
      });
      if (!saved.ok) {
        if (saved.error.code === "IDEMPOTENCY_MISMATCH" || saved.error.code === "VERSION_CONFLICT") {
          saveKey.current = retainOrCreateSetupIdempotencyKey(undefined);
        }
        setError({
          message: saved.error.message || copy.changeLoadError,
          retryable: saved.error.retryable || saved.error.status === 0,
          status: saved.error.status,
          code: saved.error.code,
        });
        return;
      }
      applyDraft(saved.data);
      const previewed = await runOwnerRequest<ChangePreviewRecord>({
        path: `/v1/drafts/${saved.data.id}/preview`,
        method: "POST",
        ifMatch: saved.data.version,
      });
      if (!previewed.ok) {
        setOperationNotice(presentChangePreviewFailure(previewed.error));
        return;
      }
      if (!recipient && previewed.data.snapshot.customer.email) {
        setRecipient(previewed.data.snapshot.customer.email);
      }
      setPreview(previewed.data);
      setConfirming(false);
    } finally {
      previewInFlight.current = false;
      setBusy(false);
    }
  }

  async function publishChange() {
    const plan = changeRecipientPlan({
      previewEmail: preview?.snapshot.customer.email,
      enteredEmail: recipient || preview?.snapshot.customer.email || "",
    });
    if (plan.kind !== "ready") {
      const blocked = presentChangeRecipient(plan);
      if (blocked) {
        setOperationNotice(blocked);
      }
      setConfirming(false);
      return;
    }
    const started = beginChangePublishRequest({
      confirming,
      preview,
      inFlight: publishInFlight,
      idempotencyKey: publishKey.current,
    });
    if (started.kind === "ignored") {
      return;
    }
    if (started.kind !== "request") {
      setOperationNotice(presentBlockedChangePublish(started.kind));
      setConfirming(false);
      return;
    }
    publishKey.current = started.idempotencyKey;
    setBusy(true);
    setOperationNotice(undefined);
    try {
      const published = await runOwnerRequest<{ id?: string }>({
        path: started.path,
        method: started.method,
        idempotencyKey: started.idempotencyKey,
        ifMatch: started.ifMatch,
        body: started.body,
      });
      if (!published.ok) {
        const notice = presentChangePublishResponse({
          ok: false,
          status: published.error.status,
          code: published.error.code,
          message: published.error.message,
          retryable: published.error.retryable,
        });
        if (notice.recovery !== "check_draft") {
          publishKey.current = extraWorkIdempotencyAfterFailure(publishKey.current, published.error.code);
        }
        if (notice.recovery === "refresh_preview") {
          setPreview((current) => changePreviewAfterFailure(current, published.error.code));
        }
        setOperationNotice(notice);
        setConfirming(false);
        return;
      }
      const publishedId = typeof published.data?.id === "string" ? published.data.id : "";
      if (!publishedId) {
        setOperationNotice(presentChangePublishResponse({ ok: true, status: 202 }));
        setConfirming(false);
        return;
      }
      router.replace(jobDetailPath(props.jobId));
    } finally {
      publishInFlight.current = false;
      setBusy(false);
    }
  }

  const view = presentChangeEditor({
    authStatus: auth.snapshot.status,
    loading,
    draft,
    error,
  });
  const title = props.mode === "reductions" ? copy.reduceTitle : copy.changeTitle;

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {view.kind === "loading" ? <ActivityIndicator color={colors.navy} /> : null}
        {view.kind === "offline" || view.kind === "error" || view.kind === "blocked" ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {view.message}
            </Text>
            {view.showRetry ? (
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                <Text style={styles.secondaryLabel}>{copy.retry}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
        {view.draft ? (
          <>
            <Text style={styles.section}>{copy.changeReason}</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              style={styles.input}
              maxLength={500}
              editable={!offline && !busy}
            />
            <Text style={styles.body}>
              {copy.changePreviousTotal}: {formatUsdCents(view.draft.previous_total_cents)}
            </Text>
            <Text style={styles.body}>
              {copy.changeDelta}: {formatUsdCents(view.draft.change_including_tax_cents)}
            </Text>
            <Text style={styles.body}>
              {copy.changeNewTotal}: {formatUsdCents(view.draft.new_agreed_total_cents)}
            </Text>
            {props.mode === "additions" ? (
              <>
                {additions.map((line, index) => (
                  <View key={line.client_line_id} style={styles.card}>
                    <TextInput
                      value={line.description}
                      onChangeText={(value) =>
                        setAdditions((current) =>
                          current.map((item, itemIndex) => (itemIndex === index ? { ...item, description: value } : item)),
                        )
                      }
                      style={styles.input}
                      editable={!offline && !busy}
                    />
                    <TextInput
                      value={line.quantity}
                      onChangeText={(value) =>
                        setAdditions((current) =>
                          current.map((item, itemIndex) => (itemIndex === index ? { ...item, quantity: value } : item)),
                        )
                      }
                      keyboardType="decimal-pad"
                      style={styles.input}
                      editable={!offline && !busy}
                    />
                    <TextInput
                      value={line.unit_price}
                      onChangeText={(value) =>
                        setAdditions((current) =>
                          current.map((item, itemIndex) => (itemIndex === index ? { ...item, unit_price: value } : item)),
                        )
                      }
                      keyboardType="decimal-pad"
                      style={styles.input}
                      editable={!offline && !busy}
                    />
                  </View>
                ))}
                <Pressable
                  accessibilityRole="button"
                  disabled={offline || busy}
                  onPress={() =>
                    setAdditions((current) => [
                      ...current,
                      { client_line_id: secureRandomUUID(), description: "", quantity: "1", unit_price: "" },
                    ])
                  }
                  style={styles.secondary}
                >
                  <Text style={styles.secondaryLabel}>{copy.changeAddLine}</Text>
                </Pressable>
              </>
            ) : (
              view.draft.sources.map((source) => (
                <View key={source.source_line_id} style={styles.card}>
                  <Text style={styles.body}>{source.description}</Text>
                  <Text style={styles.muted}>
                    {copy.sourceRemaining}: {formatUsdCents(source.remaining_net_cents + source.remaining_tax_cents)}
                  </Text>
                  <TextInput
                    value={credits[source.source_line_id] ?? ""}
                    onChangeText={(value) => setCredits((current) => ({ ...current, [source.source_line_id]: value }))}
                    keyboardType="decimal-pad"
                    style={styles.input}
                    editable={!offline && !busy}
                  />
                </View>
              ))
            )}
            {view.kind === "empty" ? <Text style={styles.muted}>{copy.changeEmpty}</Text> : null}
            <Text style={styles.section}>{copy.changeRecipient}</Text>
            <TextInput
              value={recipient}
              onChangeText={setRecipient}
              autoCapitalize="none"
              keyboardType="email-address"
              style={styles.input}
              editable={!offline && !busy}
            />
            {operationNotice ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {operationNotice.message}
              </Text>
            ) : null}
            {preview ? <Text style={styles.body}>{copy.previewNotPublished}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: offline || busy }}
              disabled={offline || busy}
              onPress={() => void saveAndPreview()}
              style={styles.primary}
            >
              <Text style={styles.primaryLabel}>{busy && !confirming ? copy.changePreviewOpening : copy.extraWorkContinue}</Text>
            </Pressable>
            {preview ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: offline || busy, busy: confirming && busy }}
                disabled={offline || busy}
                onPress={() => {
                  if (operationNotice?.recovery === "check_draft") {
                    return;
                  }
                  if (!confirming) {
                    setConfirming(true);
                    return;
                  }
                  void publishChange();
                }}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>
                  {confirming ? (busy ? copy.changePublishing : copy.changePublishConfirm) : copy.changePublish}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => router.replace(jobDetailPath(props.jobId))} style={styles.secondary}>
          <Text style={styles.secondaryLabel}>{copy.back}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  section: { color: colors.text, fontSize: type.section, fontWeight: "600", marginTop: space.scale },
  body: { color: colors.text, fontSize: type.body },
  muted: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: 12,
    color: colors.text,
  },
  card: { gap: 8, padding: 12, borderWidth: 1, borderColor: colors.navy, borderRadius: space.radius },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    backgroundColor: colors.navy,
    marginTop: space.gutter,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "700" },
  secondary: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
    marginTop: space.gutter,
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});
