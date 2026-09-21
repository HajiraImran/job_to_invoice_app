import { Slot, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { missingPublicEnvNames } from "../src/config.ts";
import { copy } from "../src/i18n/en.ts";
import { AuthProvider, useAuth } from "../src/session/AuthProvider.tsx";
import { resolveOwnerGuard } from "../src/session/logic.ts";
import { colors, type } from "../src/theme.ts";

function Guard() {
  const auth = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    const decision = resolveOwnerGuard({
      snapshot: auth.snapshot,
      segments: [...segments],
      resumeHref: auth.pendingReplace?.returnRoute,
    });
    if (decision.action === "replace") {
      router.replace(decision.href);
    }
  }, [auth.pendingReplace?.returnRoute, auth.snapshot, router, segments]);

  const overlay = auth.snapshot.status === "restoring" || auth.snapshot.status === "authenticating";

  return (
    <View style={styles.root}>
      <Slot />
      {overlay ? (
        <View
          accessibilityLiveRegion="polite"
          pointerEvents="auto"
          style={styles.overlay}
        >
          <ActivityIndicator color={colors.navy} />
          <Text style={styles.splashText}>{copy.restoring}</Text>
        </View>
      ) : null}
    </View>
  );
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
  root: { flex: 1 },
  splash: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 12,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
    gap: 12,
    zIndex: 2,
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
