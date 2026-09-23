import { useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED } from "../../../src/drafts/sync.ts";
import { copy } from "../../../src/i18n/en.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { signOutAlertSpec, signOutChoiceProceeds } from "../../../src/session/sign-out.ts";
import { subscriptionPath } from "../../../src/subscription/presentation.ts";
import { colors, space, type } from "../../../src/theme.ts";

export default function SettingsScreen() {
  const auth = useAuth();
  const router = useRouter();
  const [syncSummary, setSyncSummary] = useState<string | undefined>();

  const refreshSyncSummary = useCallback(async () => {
    const status = await auth.draftStatus();
    if (!LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED || !status.synchronizeAvailable) {
      setSyncSummary(undefined);
      return;
    }
    setSyncSummary(status.hasUnsyncedDrafts ? copy.syncPendingCount : copy.jobSyncedBadge);
  }, [auth]);

  useEffect(() => {
    void refreshSyncSummary();
  }, [refreshSyncSummary, auth.snapshot.status]);

  async function onSignOut() {
    const drafts = await auth.draftStatus();
    const spec = signOutAlertSpec(drafts, LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED);
    if (spec.kind === "unsynced") {
      const buttons = [
        { text: copy.staySignedIn, style: "cancel" as const },
        ...(spec.offerSynchronize
          ? [
              {
                text: copy.synchronize,
                onPress: () => {
                  if (signOutChoiceProceeds("synchronize")) {
                    void auth.signOut("synchronize");
                  }
                },
              },
            ]
          : []),
        {
          text: copy.discardAndSignOut,
          style: "destructive" as const,
          onPress: () => {
            if (signOutChoiceProceeds("discard")) {
              void auth.signOut("discard");
            }
          },
        },
      ];
      Alert.alert(copy.unsyncedTitle, spec.offerSynchronize ? copy.unsyncedBody : copy.syncUnavailable, buttons);
      return;
    }
    Alert.alert(copy.signOut, copy.signOutConfirm, [
      { text: copy.staySignedIn, style: "cancel" },
      {
        text: copy.signOut,
        style: "destructive",
        onPress: () => {
          if (signOutChoiceProceeds("confirm")) {
            void auth.signOut("confirm");
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.settingsTitle}
      </Text>
      {auth.snapshot.status === "offline_cached" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.offlineCached}
        </Text>
      ) : null}
      {auth.snapshot.status === "access_expired" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.accessExpired}
        </Text>
      ) : null}
      <Text style={styles.body}>{auth.bootstrap?.user.display_email ?? auth.snapshot.emailDisplay}</Text>
      {syncSummary ? (
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {copy.syncStatusLabel}: {syncSummary}
        </Text>
      ) : null}
      {LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.synchronizeNow}
          onPress={() => void auth.synchronizeNow().then(() => refreshSyncSummary())}
          style={styles.syncButton}
        >
          <Text style={styles.syncLabel}>{copy.synchronizeNow}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.subscriptionTitle}
        onPress={() => router.push(subscriptionPath())}
        style={styles.syncButton}
      >
        <Text style={styles.syncLabel}>{copy.subscriptionTitle}</Text>
      </Pressable>
      {auth.error ? (
        <Text accessibilityLiveRegion="assertive" style={styles.banner}>
          {auth.error}
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => void onSignOut()} style={styles.button}>
        <Text style={styles.buttonLabel}>{copy.signOut}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  banner: { color: colors.navy, fontSize: type.secondary },
  body: { color: colors.secondary, fontSize: type.body },
  syncButton: {
    minHeight: 44,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.scale,
  },
  syncLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  button: {
    minHeight: 44,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.gutter,
  },
  buttonLabel: { color: colors.danger, fontSize: type.body, fontWeight: "600" },
});
