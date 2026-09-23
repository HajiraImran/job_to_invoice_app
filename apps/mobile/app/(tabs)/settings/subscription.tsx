import { ANALYTICS_SCHEMA_VERSION } from "@job-to-invoice/schemas";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../../../src/crypto/uuid.ts";
import { copy } from "../../../src/i18n/en.ts";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import {
  paywallViewedProperties,
  presentSubscription,
  type SubscriptionRecord,
} from "../../../src/subscription/presentation.ts";
import { colors, space, type } from "../../../src/theme.ts";

function formatEnds(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

export default function SubscriptionScreen() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ from?: string }>();
  const [subscription, setSubscription] = useState<SubscriptionRecord | undefined>();
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const viewed = useRef(false);
  const startKey = useRef(retainOrCreateSetupIdempotencyKey(undefined));

  const load = useCallback(async () => {
    setLoading(true);
    const result = await auth.runOwnerRequest<SubscriptionRecord>({
      path: "/v1/subscription",
      method: "GET",
    });
    if (result.ok) {
      setSubscription(result.data);
      setError(undefined);
    } else {
      setError(result.error.message || copy.subscriptionLoadError);
    }
    setLoading(false);
  }, [auth]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (viewed.current || auth.snapshot.status !== "authenticated") {
      return;
    }
    viewed.current = true;
    const entry = params.from === "publish" ? "publish" : "settings";
    void auth.runOwnerRequest({
      path: "/v1/analytics/batch",
      method: "POST",
      idempotencyKey: secureRandomUUID(),
      body: {
        events: [
          {
            event_id: secureRandomUUID(),
            event_name: "paywall_viewed",
            schema_version: ANALYTICS_SCHEMA_VERSION,
            occurred_at: new Date().toISOString(),
            properties: paywallViewedProperties(entry),
          },
        ],
      },
    });
  }, [auth, params.from]);

  async function onStartTrial() {
    if (starting) {
      return;
    }
    setStarting(true);
    const result = await auth.runOwnerRequest<SubscriptionRecord>({
      path: "/v1/subscription/trial",
      method: "POST",
      idempotencyKey: startKey.current,
      body: { acknowledged: true },
    });
    if (result.ok) {
      setSubscription(result.data);
      setError(undefined);
      await auth.refreshBootstrap();
    } else {
      if (result.error.code === "IDEMPOTENCY_MISMATCH") {
        startKey.current = retainOrCreateSetupIdempotencyKey(undefined);
      }
      setError(result.error.message || copy.subscriptionStartError);
    }
    setStarting(false);
  }

  const view = presentSubscription({
    authStatus: auth.snapshot.status,
    loading,
    starting,
    subscription,
    error,
  });

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.subscriptionTitle}
      </Text>
      {view.kind === "offline" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.subscriptionOffline}
        </Text>
      ) : null}
      {view.kind === "access_expired" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.accessExpired}
        </Text>
      ) : null}
      {view.kind === "loading" || view.kind === "starting" ? <ActivityIndicator color={colors.navy} /> : null}
      {view.message ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {view.message}
        </Text>
      ) : null}
      {subscription ? (
        <>
          <Text style={styles.body}>
            {copy.subscriptionFreeUsage
              .replace("{used}", String(subscription.free_jobs_consumed))
              .replace("{limit}", "3")}
          </Text>
          {subscription.trial?.active ? (
            <Text style={styles.body}>
              {copy.subscriptionTrialActive
                .replace("{date}", formatEnds(subscription.trial.ends_at))
                .replace("{used}", String(subscription.trial.jobs_consumed))
                .replace("{limit}", "20")}
            </Text>
          ) : null}
          {subscription.trial && !subscription.trial.active ? (
            <Text accessibilityLiveRegion="polite" style={styles.banner}>
              {copy.subscriptionEnded}
            </Text>
          ) : null}
          <Text style={styles.body}>{copy.subscriptionTrialDisclosure}</Text>
        </>
      ) : null}
      {view.kind === "error" ? (
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
          <Text style={styles.secondaryLabel}>{copy.retry}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.subscriptionStart}
        accessibilityState={{ disabled: view.startDisabled }}
        disabled={view.startDisabled}
        onPress={() => void onStartTrial()}
        style={[styles.button, view.startDisabled ? styles.disabled : null]}
      >
        <Text style={styles.buttonLabel}>{starting ? copy.subscriptionStarting : copy.subscriptionStart}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  banner: { color: colors.navy, fontSize: type.secondary },
  body: { color: colors.secondary, fontSize: type.body },
  secondary: {
    minHeight: 44,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  button: {
    minHeight: 44,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.scale,
  },
  buttonLabel: { color: colors.background, fontSize: type.body, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
