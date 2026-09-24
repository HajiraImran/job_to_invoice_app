import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../../src/crypto/uuid.ts";
import { customerMutationDenied } from "../../../../src/customers/form.ts";
import {
  CUSTOMER_PRIMARY_MIN_PT,
  CUSTOMER_TARGET_MIN_PT,
  formatBillingAddress,
  type CustomerRecord,
} from "../../../../src/customers/presentation.ts";
import { copy } from "../../../../src/i18n/en.ts";
import { useAuth } from "../../../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../../../src/theme.ts";

type JobRow = { id: string; title: string; lifecycle: string };

export default function CustomerDetailScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const customerId = typeof params.id === "string" ? params.id : "";
  const [customer, setCustomer] = useState<CustomerRecord | undefined>();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (auth.snapshot.status !== "authenticated" || !customerId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [customerResult, jobResult] = await Promise.all([
      auth.runOwnerRequest<CustomerRecord>({ path: `/v1/customers/${customerId}` }),
      auth.runOwnerRequest<{ items: JobRow[] }>({ path: `/v1/jobs?customer_id=${customerId}` }),
    ]);
    setLoading(false);
    if (!customerResult.ok) {
      setMessage(customerResult.error.message);
      return;
    }
    setCustomer(customerResult.data);
    setJobs(jobResult.ok ? jobResult.data.items : []);
  }, [auth, customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function archive(archived: boolean) {
    if (customerMutationDenied(auth.snapshot.status)) {
      setMessage(copy.customersOffline);
      return;
    }
    const result = await auth.runOwnerRequest<CustomerRecord>({
      path: `/v1/customers/${customerId}/archive`,
      method: "POST",
      body: { archived },
      idempotencyKey: secureRandomUUID(),
    });
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setCustomer(result.data);
  }

  async function remove() {
    if (customerMutationDenied(auth.snapshot.status)) {
      setMessage(copy.customersOffline);
      return;
    }
    const result = await auth.runOwnerRequest<{ deleted: boolean }>({
      path: `/v1/customers/${customerId}`,
      method: "DELETE",
      idempotencyKey: secureRandomUUID(),
    });
    if (!result.ok) {
      setMessage(result.error.code === "CUSTOMER_REFERENCED" ? copy.customerReferenced : result.error.message);
      return;
    }
    router.replace("/customers");
  }

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + space.gutter }]} style={styles.flex}>
      <Text accessibilityRole="header" style={styles.title}>
        {customer?.name ?? copy.customersTitle}
      </Text>
      {loading ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.customersLoading}
        </Text>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {message}
        </Text>
      ) : null}
      {auth.snapshot.status !== "authenticated" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.customersOffline}
        </Text>
      ) : null}
      {customer ? (
        <View>
          <Text style={styles.banner}>{customer.email ?? ""}</Text>
          <Text style={styles.banner}>{customer.phone ?? ""}</Text>
          <Text style={styles.banner}>{formatBillingAddress(customer.billing_address)}</Text>
        </View>
      ) : null}
      <Text accessibilityRole="header" style={styles.section}>
        {copy.customerJobs}
      </Text>
      {jobs.length === 0 ? <Text style={styles.banner}>{copy.customerJobsEmpty}</Text> : null}
      {jobs.map((job) => (
        <Pressable accessibilityRole="button" key={job.id} onPress={() => router.push(`/jobs/${job.id}`)} style={styles.target}>
          <Text style={styles.targetLabel}>
            {job.title} · {job.lifecycle}
          </Text>
        </Pressable>
      ))}
      {customer && auth.snapshot.status === "authenticated" ? (
        <>
          <Pressable accessibilityRole="button" onPress={() => router.push(`/customers/${customerId}/edit`)} style={styles.primary}>
            <Text style={styles.primaryLabel}>{copy.saveCustomer}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void archive(customer.archived_at === null)}
            style={styles.target}
          >
            <Text style={styles.targetLabel}>{customer.archived_at ? copy.customerRestore : copy.customerArchive}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => void remove()} style={styles.target}>
            <Text style={styles.targetLabel}>{copy.customerDelete}</Text>
          </Pressable>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.gutter, gap: space.scale, paddingBottom: 48 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  section: { color: colors.text, fontSize: type.section, fontWeight: "700", marginTop: space.scale },
  banner: { color: colors.navy, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  target: {
    minHeight: CUSTOMER_TARGET_MIN_PT,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.navy,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
  },
  targetLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "600" },
  primary: {
    minHeight: CUSTOMER_PRIMARY_MIN_PT,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "600" },
});
