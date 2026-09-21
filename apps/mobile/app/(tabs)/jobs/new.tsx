import { US_STATES } from "@job-to-invoice/schemas";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../src/crypto/uuid.ts";
import { copy } from "../../../src/i18n/en.ts";
import { emptyJobForm, firstJobFieldError, jobFormFocusName, jobRequestFromForm, type JobFormValues } from "../../../src/jobs/form.ts";
import { type JobDetail } from "../../../src/jobs/presentation.ts";
import { upsertCachedJob } from "../../../src/jobs/cache.ts";
import { jobDetailPath, jobsIndexPath } from "../../../src/jobs/routes.ts";
import { enqueueOutboxOperation } from "../../../src/sync/outbox.ts";
import { isOfflineReadPermitted } from "@job-to-invoice/schemas";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../src/theme.ts";

export default function CreateJobScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [values, setValues] = useState<JobFormValues>(emptyJobForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const jobId = useRef<string | undefined>(undefined);
  jobId.current = retainOrCreateSetupIdempotencyKey(jobId.current);
  const idempotencyKey = useRef<string | undefined>(undefined);
  idempotencyKey.current = retainOrCreateSetupIdempotencyKey(idempotencyKey.current);
  const inputs = useRef<Record<string, TextInput | null>>({});

  const setField = useCallback(<K extends keyof JobFormValues>(key: K, value: JobFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const parsed = useMemo(() => jobRequestFromForm(values, jobId.current ?? ""), [values]);

  function focusField(field?: string) {
    if (!field) {
      return;
    }
    inputs.current[jobFormFocusName(field)]?.focus();
  }

  async function submit() {
    if (auth.snapshot.status === "access_expired") {
      setFormError(copy.accessExpired);
      return;
    }
    if (
      auth.snapshot.status === "offline_cached" &&
      !isOfflineReadPermitted(auth.snapshot.lastAuthenticatedAt, Date.now())
    ) {
      setFormError(copy.accessExpired);
      return;
    }
    if (!parsed.ok) {
      const next: Record<string, string> = {};
      for (const item of parsed.field_errors) {
        next[item.field] = item.message;
      }
      setErrors(next);
      setFormError(copy.jobCreateError);
      focusField(firstJobFieldError(next));
      return;
    }
    setSubmitting(true);
    setFormError(undefined);
    setErrors({});
    const session = auth.getSyncSessionDb();

    if (auth.snapshot.status === "offline_cached") {
      if (!session) {
        setSubmitting(false);
        setFormError(copy.quoteStorageFailure);
        return;
      }
      try {
        const pendingJob: JobDetail = {
          id: parsed.value.id,
          customer_id: parsed.value.id,
          customer_name: parsed.value.customer_name,
          title: parsed.value.title,
          lifecycle: "draft",
          mode: parsed.value.mode,
          no_site: parsed.value.no_site,
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          site_address: parsed.value.site_address ?? null,
          internal_notes: parsed.value.internal_notes ?? "",
          permitted_actions: [],
          quote_draft: null,
          current_quote: null,
          active_invoice: null,
          latest_invoice: null,
        };
        await upsertCachedJob(session.db, {
          jobId: pendingJob.id,
          payloadJson: JSON.stringify(pendingJob),
          listState: "active",
          syncBadge: "pending",
          serverConfirmed: false,
        });
        await enqueueOutboxOperation(session.db, {
          operationId: idempotencyKey.current ?? secureRandomUUID(),
          resourceKind: "job",
          resourceId: pendingJob.id,
          method: "POST",
          path: "/v1/jobs",
          bodyJson: JSON.stringify(parsed.value),
          idempotencyKey: idempotencyKey.current ?? secureRandomUUID(),
        });
        setSubmitting(false);
        setFormError(copy.jobOfflineCreate);
        router.replace(jobDetailPath(pendingJob.id));
        return;
      } catch {
        setSubmitting(false);
        setFormError(copy.quoteStorageFailure);
        return;
      }
    }

    const result = await auth.runOwnerRequest<JobDetail>({
      path: "/v1/jobs",
      method: "POST",
      body: parsed.value,
      idempotencyKey: idempotencyKey.current,
    });
    setSubmitting(false);
    if (result.ok) {
      if (session) {
        try {
          await upsertCachedJob(session.db, {
            jobId: result.data.id,
            payloadJson: JSON.stringify(result.data),
            listState: "active",
            syncBadge: "synced",
            serverConfirmed: true,
          });
        } catch {
          /* ignore */
        }
      }
      router.replace(jobDetailPath(result.data.id));
      return;
    }
    if (result.error.code === "IDEMPOTENCY_MISMATCH") {
      idempotencyKey.current = retainOrCreateSetupIdempotencyKey(undefined);
    }
    const fieldErrors: Record<string, string> = {};
    for (const item of result.error.field_errors ?? []) {
      fieldErrors[item.field] = item.message;
    }
    setErrors(fieldErrors);
    setFormError(result.error.message || copy.jobCreateError);
    focusField(firstJobFieldError(fieldErrors));
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.flex, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <Text accessibilityRole="header" style={styles.title}>
          {copy.createJob}
        </Text>
        {auth.snapshot.status === "offline_cached" ? (
          <Text accessibilityLiveRegion="polite" style={styles.banner}>
            {copy.offlineCached}
          </Text>
        ) : null}
        {formError ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {formError}
          </Text>
        ) : null}

        <Field
          error={errors.customer_name}
          label={copy.customerName}
          name="customer_name"
          onChange={setField}
          register={inputs}
          required
          value={values.customer_name}
        />
        <Field
          error={errors.title}
          label={copy.jobTitle}
          name="title"
          onChange={setField}
          register={inputs}
          required
          value={values.title}
        />

        <Text nativeID="mode-label" style={styles.label}>
          {copy.jobMode} ({copy.jobRequired})
        </Text>
        <View accessibilityRole="radiogroup">
          <Choice
            label={copy.modeQuote}
            onPress={() => setField("mode", "quote")}
            selected={values.mode === "quote"}
          />
          <Choice
            label={copy.modeDirect}
            onPress={() => setField("mode", "direct_invoice")}
            selected={values.mode === "direct_invoice"}
          />
        </View>
        {errors.mode ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {errors.mode}
          </Text>
        ) : null}

        <Check
          hint={copy.noSiteHint}
          label={copy.noSiteAddress}
          onPress={() => setField("no_site", !values.no_site)}
          selected={values.no_site}
        />

        {values.no_site ? null : (
          <>
            <Text style={styles.label}>{copy.jobSite}</Text>
            <Field
              error={errors["site_address.line1"] ?? errors.site_address}
              label={copy.addressLine1}
              name="line1"
              onChange={setField}
              register={inputs}
              required
              value={values.line1}
            />
            <Field
              error={errors["site_address.line2"]}
              label={copy.addressLine2}
              name="line2"
              onChange={setField}
              register={inputs}
              value={values.line2}
            />
            <Field
              error={errors["site_address.city"]}
              label={copy.city}
              name="city"
              onChange={setField}
              register={inputs}
              required
              value={values.city}
            />
            <Text nativeID="state-label" style={styles.label}>
              {copy.state} ({copy.jobRequired})
            </Text>
            <View accessibilityRole="radiogroup" style={styles.wrap}>
              {US_STATES.map((state) => (
                <Choice
                  key={state}
                  compact
                  label={state}
                  onPress={() => setField("state", state)}
                  selected={values.state === state}
                />
              ))}
            </View>
            {errors["site_address.state"] ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {errors["site_address.state"]}
              </Text>
            ) : null}
            <Field
              error={errors["site_address.postal_code"]}
              keyboardType="number-pad"
              label={copy.zip}
              name="postal_code"
              onChange={setField}
              register={inputs}
              required
              textContentType="postalCode"
              value={values.postal_code}
            />
          </>
        )}

        <Field
          error={errors.internal_notes}
          hint={copy.internalNotesHint}
          label={copy.internalNotes}
          multiline
          name="internal_notes"
          onChange={setField}
          register={inputs}
          value={values.internal_notes}
        />

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: submitting, disabled: submitting }}
            disabled={submitting}
            onPress={() => void submit()}
            style={[styles.button, submitting ? styles.buttonDisabled : null]}
          >
            <Text style={styles.buttonLabel}>{submitting ? copy.creatingJob : copy.createJob}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace(jobsIndexPath())}
            style={styles.secondary}
          >
            <Text style={styles.secondaryLabel}>{copy.back}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: {
  name: string;
  label: string;
  value: string;
  onChange: <K extends keyof JobFormValues>(key: K, value: JobFormValues[K]) => void;
  register: { current: Record<string, TextInput | null> };
  error?: string;
  required?: boolean;
  multiline?: boolean;
  hint?: string;
  keyboardType?: TextInput["props"]["keyboardType"];
  textContentType?: TextInput["props"]["textContentType"];
}) {
  const labelId = `${props.name}-label`;
  return (
    <View>
      <Text nativeID={labelId} style={styles.label}>
        {props.label}
        {props.required ? ` (${copy.jobRequired})` : ""}
      </Text>
      <TextInput
        accessibilityLabel={`${props.label}${props.required ? `, ${copy.jobRequired}` : ""}`}
        accessibilityHint={props.error ?? props.hint}
        accessibilityLabelledBy={labelId}
        keyboardType={props.keyboardType}
        multiline={props.multiline}
        nativeID={props.name}
        onChangeText={(text) => props.onChange(props.name as keyof JobFormValues, text)}
        ref={(node) => {
          props.register.current[props.name] = node;
        }}
        style={[styles.input, props.multiline ? styles.multiline : null, props.error ? styles.inputError : null]}
        textContentType={props.textContentType}
        value={props.value}
      />
      {props.hint && !props.error ? <Text style={styles.hint}>{props.hint}</Text> : null}
      {props.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

function Choice(props: { label: string; selected: boolean; onPress: () => void; compact?: boolean }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[styles.choice, props.compact ? styles.choiceCompact : null, props.selected ? styles.choiceSelected : null]}
    >
      <Text style={[styles.choiceLabel, props.selected ? styles.choiceLabelSelected : null]}>{props.label}</Text>
    </Pressable>
  );
}

function Check(props: { label: string; selected: boolean; onPress: () => void; hint?: string }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.selected }}
      accessibilityHint={props.hint}
      onPress={props.onPress}
      style={styles.check}
    >
      <Text style={styles.choiceLabel}>
        {props.selected ? "☑ " : "☐ "}
        {props.label}
      </Text>
      {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  banner: { color: colors.navy, fontSize: type.secondary },
  label: { color: colors.text, fontSize: type.secondary, marginTop: space.scale },
  hint: { color: colors.secondary, fontSize: type.secondary, marginTop: 4 },
  error: { color: colors.danger, fontSize: type.secondary },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: "#FFFFFF",
  },
  multiline: { minHeight: 96, textAlignVertical: "top", paddingVertical: space.scale },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: 44,
    minWidth: 44,
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    justifyContent: "center",
    marginTop: 4,
  },
  choiceCompact: { paddingHorizontal: 10 },
  choiceSelected: { backgroundColor: colors.navy },
  choiceLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  choiceLabelSelected: { color: "#FFFFFF" },
  check: { minHeight: 44, justifyContent: "center", marginTop: space.scale },
  actions: { gap: space.scale, marginTop: space.gutter },
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
});
