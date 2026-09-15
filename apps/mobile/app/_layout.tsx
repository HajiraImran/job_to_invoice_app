import { routeGroupFor } from "@job-to-invoice/schemas";
import { Slot, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { missingPublicEnvNames } from "../src/config.ts";
import { copy } from "../src/i18n/en.ts";
import { AuthProvider, useAuth } from "../src/session/AuthProvider.tsx";
import { colors, type } from "../src/theme.ts";

function Guard() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const group = routeGroupFor(auth.snapshot);

  useEffect(() => {
    if (auth.snapshot.status === "restoring" || auth.snapshot.status === "authenticating") {
      return;
    }
    const parts = [...segments];
    const root = parts[0];
    const page = parts[1];
    if (group === "public" && root !== "(public)") {
      router.replace("/(public)/welcome");
    } else if (group === "verify" && page !== "verify") {
      router.replace("/(public)/verify");
    } else if (group === "onboarding" && root !== "(onboarding)") {
      router.replace("/(onboarding)/setup");
    } else if (group === "app" && root !== "(tabs)") {
      router.replace("/(tabs)/jobs");
    }
  }, [auth.snapshot.status, group, router, segments]);

  if (auth.snapshot.status === "restoring" || auth.snapshot.status === "authenticating") {
    return (
      <View style={styles.splash} accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.navy} />
        <Text style={styles.splashText}>{copy.restoring}</Text>
      </View>
    );
  }

  return <Slot />;
}

function ConfigurationError({ names }: { names: string[] }) {
  return (
    <View style={styles.splash} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Text style={styles.splashText}>{copy.configMissingTitle}</Text>
      <Text style={styles.configBody}>{copy.configMissingBody}</Text>
      <Text style={styles.configNames}>{names.join("\n")}</Text>
    </View>
  );
}

export default function RootLayout() {
  const missing = missingPublicEnvNames();
  if (missing.length > 0) {
    return <ConfigurationError names={missing} />;
  }
  return (
    <AuthProvider>
      <Guard />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 12,
  },
  splashText: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  configBody: {
    color: colors.secondary,
    fontSize: type.secondary,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  configNames: {
    color: colors.navy,
    fontSize: type.secondary,
    textAlign: "center",
    paddingHorizontal: 24,
  },
});
