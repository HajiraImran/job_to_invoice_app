import { isOfflineReadPermitted } from "@job-to-invoice/schemas";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../src/crypto/uuid.ts";
import { copy } from "../../../src/i18n/en.ts";
import { CustomerPickerSheet } from "../../../src/jobs/CustomerPickerSheet.tsx";
import {
  CREATE_JOB_GUTTER,
  presentCreateJobCustomerLabel,
  presentCreateJobNextHref,
  presentCreateJobReady,
  presentCreateJobScreen,
  presentModeCards,
  presentSiteFieldValue,
} from "../../../src/jobs/create-presentation.ts";
import {
  CreateJobAddCustomer,
  CreateJobHeading,
  CreateJobModeCard,
  CreateJobPrimaryButton,
  CreateJobSelectField,
  CreateJobSiteChoice,
  CreateJobTextField,
  createJobErrorStyle,
  createJobNoticeStyle,
  createJobSectionStyle,
} from "../../../src/jobs/create-ui.tsx";
import { clearCreateJobForm, holdCreateJobForm, peekCreateJobForm } from "../../../src/jobs/create-session.ts";
import { emptyJobForm, firstJobFieldError, jobFormFocusName, jobRequestFromForm, type JobFormValues } from "../../../src/jobs/form.ts";
import { type JobDetail } from "../../../src/jobs/presentation.ts";
import { upsertCachedJob } from "../../../src/jobs/cache.ts";
import { jobsIndexPath } from "../../../src/jobs/routes.ts";
import { enqueueOutboxOperation } from "../../../src/sync/outbox.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { colors } from "../../../src/theme.ts";

export default function CreateJobScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const screen = presentCreateJobScreen();
  const [values, setValues] = useState<JobFormValues>(emptyJobForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [siteChooserOpen, setSiteChooserOpen] = useState(false);
  const params = useLocalSearchParams<{ relatedJobId?: string | string[]; customerId?: string | string[]; customerName?: string | string[] }>();
  const relatedJobId =
    typeof params.relatedJobId === "string" ? params.relatedJobId : Array.isArray(params.relatedJobId) ? (params.relatedJobId[0] ?? "") : "";
  const [submitting, setSubmitting] = useState(false);
  const jobId = useRef<string | undefined>(undefined);
  jobId.current = retainOrCreateSetupIdempotencyKey(jobId.current);
  const idempotencyKey = useRef<string | undefined>(undefined);
  idempotencyKey.current = retainOrCreateSetupIdempotencyKey(idempotencyKey.current);
  const inputs = useRef<Record<string, TextInput | null>>({});

  const setField = useCallback(<K extends keyof JobFormValues>(key: K, value: JobFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);
  const online = auth.snapshot.status === "authenticated";
  const selectedCustomerId = firstParam(params.customerId);
  const selectedCustomerName = firstParam(params.customerName);

  useEffect(() => {
    const held = peekCreateJobForm();
    if (held) {
      setValues(held);
    }
  }, []);

  useEffect(() => {
    if (!selectedCustomerId) return;
    setField("customer_id", selectedCustomerId);
    if (selectedCustomerName) setField("customer_name", selectedCustomerName);
  }, [selectedCustomerId, selectedCustomerName, setField]);

  const parsed = useMemo(
    () => jobRequestFromForm(values, jobId.current ?? "", relatedJobId || undefined, { savedCustomer: online }),
    [online, relatedJobId, values],
  );
  const ready = presentCreateJobReady(values, online, submitting);
  const modes = presentModeCards(values.mode);

  function openAddCustomer() {
    holdCreateJobForm(values);
    setPickerOpen(false);
    router.push({
      pathname: "/customers/new",
      params: relatedJobId ? { returnTo: "job", relatedJobId } : { returnTo: "job" },
    });
  }

  function focusField(field?: string) {
    if (!field) {
      return;
    }
    inputs.current[jobFormFocusName(field)]?.focus();
  }

  async function submit() {
    if (submitting) {
      return;
    }
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
          customer_id: parsed.value.customer_id ?? "",
          customer_name: parsed.value.customer_name ?? "",
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
          change_draft: null,
          latest_change: null,
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
        clearCreateJobForm();
        router.replace(presentCreateJobNextHref(pendingJob.id, parsed.value.mode, false));
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
      clearCreateJobForm();
      router.replace(presentCreateJobNextHref(result.data.id, parsed.value.mode, true));
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
    <View style={styles.root}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: insets.top + CREATE_JOB_GUTTER,
              paddingHorizontal: CREATE_JOB_GUTTER,
              paddingBottom: 24,
            },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <CreateJobHeading
            onBack={() => {
              clearCreateJobForm();
              router.replace(jobsIndexPath());
            }}
            support={screen.supportingText}
            title={relatedJobId ? copy.createLinkedJob : screen.heading}
          />
          {relatedJobId ? <Text style={createJobNoticeStyle}>{copy.linkedJobHint}</Text> : null}
          {auth.snapshot.status === "offline_cached" ? (
            <Text accessibilityLiveRegion="polite" style={createJobNoticeStyle}>
              {copy.offlineCached}
            </Text>
          ) : null}
          {formError ? (
            <Text accessibilityLiveRegion="assertive" style={createJobErrorStyle}>
              {formError}
            </Text>
          ) : null}

          <View style={styles.group}>
            <Text style={createJobSectionStyle}>{screen.billingHeading}</Text>
            <View accessibilityRole="radiogroup" style={styles.modeStack}>
              {modes.map((card) => (
                <CreateJobModeCard
                  badge={card.badge}
                  hint={card.hint}
                  icon={card.mode === "quote" ? "quote" : "invoice"}
                  key={card.mode}
                  onPress={() => setField("mode", card.mode)}
                  selected={card.selected}
                  title={card.title}
                />
              ))}
            </View>
            {errors.mode ? (
              <Text accessibilityLiveRegion="polite" style={createJobErrorStyle}>
                {errors.mode}
              </Text>
            ) : null}
          </View>

          {online ? (
            <View style={styles.group}>
              <CreateJobSelectField
                accessibilityHint={screen.pickerHint}
                error={errors.customer_id ?? errors.customer_name}
                label={presentCreateJobCustomerLabel()}
                leading="person"
                onPress={() => setPickerOpen(true)}
                placeholder={screen.customerPlaceholder}
                value={values.customer_name}
              />
              <CreateJobAddCustomer onPress={openAddCustomer} />
            </View>
          ) : (
            <CreateJobTextField
              error={errors.customer_name}
              label={copy.customerName}
              name="customer_name"
              onChange={setField}
              register={inputs}
              required
              value={values.customer_name}
            />
          )}

          <View style={styles.group}>
            <CreateJobSelectField
              accessibilityHint={copy.noSiteHint}
              error={errors.site_address}
              label={screen.siteLabel}
              leading="pin"
              onPress={() => setSiteChooserOpen((open) => !open)}
              placeholder={screen.noSiteLabel}
              value={presentSiteFieldValue(values)}
            />
            {siteChooserOpen ? (
              <View accessibilityRole="radiogroup" style={styles.modeStack}>
                <CreateJobSiteChoice
                  label={screen.noSiteLabel}
                  onPress={() => {
                    setField("no_site", true);
                    setSiteChooserOpen(false);
                  }}
                  selected={values.no_site}
                />
                <CreateJobSiteChoice
                  label={screen.addSiteLabel}
                  onPress={() => {
                    setField("no_site", false);
                    setSiteChooserOpen(false);
                  }}
                  selected={!values.no_site}
                />
              </View>
            ) : null}
          </View>

          {values.no_site ? null : (
            <View style={styles.group}>
              <CreateJobTextField
                error={errors["site_address.line1"] ?? errors.site_address}
                label={copy.addressLine1}
                name="line1"
                onChange={setField}
                register={inputs}
                required
                textContentType="streetAddressLine1"
                value={values.line1}
              />
              <CreateJobTextField
                error={errors["site_address.line2"]}
                label={copy.addressLine2}
                name="line2"
                onChange={setField}
                register={inputs}
                textContentType="streetAddressLine2"
                value={values.line2}
              />
              <CreateJobTextField
                error={errors["site_address.city"]}
                label={copy.city}
                name="city"
                onChange={setField}
                register={inputs}
                required
                textContentType="addressCity"
                value={values.city}
              />
              <CreateJobTextField
                autoCapitalize="characters"
                error={errors["site_address.state"]}
                label={copy.state}
                name="state"
                onChange={(_key, value) => setField("state", String(value).replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase())}
                register={inputs}
                required
                textContentType="addressState"
                value={values.state}
              />
              <CreateJobTextField
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
            </View>
          )}

          <CreateJobTextField
            error={errors.title}
            label={copy.jobTitle}
            name="title"
            onChange={setField}
            placeholder={screen.titlePlaceholder}
            register={inputs}
            required
            value={values.title}
          />
          <CreateJobTextField
            error={errors.internal_notes}
            hint={copy.internalNotesHint}
            label={copy.internalNotes}
            multiline
            name="internal_notes"
            onChange={setField}
            register={inputs}
            value={values.internal_notes}
          />
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), paddingHorizontal: CREATE_JOB_GUTTER }]}>
          <CreateJobPrimaryButton
            busy={submitting}
            disabled={!ready}
            label={submitting ? copy.creatingJob : copy.continueToLines}
            onPress={() => void submit()}
          />
        </View>
      </KeyboardAvoidingView>
      <CustomerPickerSheet
        onAdd={openAddCustomer}
        onClose={() => setPickerOpen(false)}
        onSelect={(id, name) => {
          setField("customer_id", id);
          setField("customer_name", name);
          setPickerOpen(false);
        }}
        selectedId={values.customer_id}
        visible={pickerOpen}
      />
    </View>
  );
}

function firstParam(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1 },
  content: { gap: 18, flexGrow: 1 },
  group: { gap: 10 },
  modeStack: { gap: 12 },
  footer: {
    paddingTop: 12,
    backgroundColor: colors.surface,
  },
});
