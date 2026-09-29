import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
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
import { EMPTY_DRAFT_SYNC, type DraftSyncStatus } from "@job-to-invoice/schemas";
import { LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED } from "../../../src/drafts/sync.ts";
import { copy } from "../../../src/i18n/en.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import { signOutChoiceProceeds, type SignOutChoice } from "../../../src/session/sign-out.ts";
import {
  SETTINGS_ACTION_PT,
  SETTINGS_GUTTER,
  SETTINGS_TARGET_MIN,
  presentSettings,
  settingsAccount,
  settingsActionBlocked,
  settingsAnalyticsProperties,
  settingsExportPath,
  settingsHardwareBack,
  settingsPlanPath,
  settingsSheetStays,
  settingsSignOutSheet,
  settingsSupportPath,
  settingsSyncLabel,
  type SettingsSheet,
  type SettingsSyncPhase,
} from "../../../src/settings/presentation.ts";
import { colors } from "../../../src/theme.ts";

const PRIMARY = "#464B71";
const TITLE = "#1F2430";
const MUTED = "#636B7D";
const LINE = "#E2E5EC";
const INFO = "#E6F0FF";
const WARN = "#FFF3D1";
const DANGER_BG = "#FAEBEB";
const DANGER_LINE = "#F0BABD";
const DANGER = "#C23840";
const SYNCED = "#1BB99A";
const PENDING = "#D7A21A";

export default function SettingsScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const draftStatus = auth.draftStatus;
  const synchronizeNow = auth.synchronizeNow;
  const signOut = auth.signOut;
  const authStatus = auth.snapshot.status;
  const bootstrapEmail = auth.bootstrap?.user.display_email;
  const fallbackEmail = auth.snapshot.emailDisplay;
  const [drafts, setDrafts] = useState<DraftSyncStatus>(EMPTY_DRAFT_SYNC);
  const [statusKnown, setStatusKnown] = useState(false);
  const [phase, setPhase] = useState<SettingsSyncPhase>("idle");
  const [sheet, setSheet] = useState<SettingsSheet>("none");
  const [signingOut, setSigningOut] = useState(false);
  const busy = useRef(false);
  const signOutRef = useRef<View>(null);
  const sheetTitleRef = useRef<Text>(null);

  const refreshDrafts = useCallback(async () => {
    const status = await draftStatus();
    setDrafts(status);
    setStatusKnown(true);
    return status;
  }, [draftStatus]);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts, authStatus]);

  const closeSheet = useCallback(() => {
    setSheet("none");
    requestAnimationFrame(() => {
      const node = findNodeHandle(signOutRef.current);
      if (node) {
        AccessibilityInfo.setAccessibilityFocus(node);
      }
    });
  }, []);

  const goBack = useCallback(() => {
    if (settingsHardwareBack(sheet !== "none") === "close_sheet") {
      closeSheet();
    }
  }, [closeSheet, sheet]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (settingsHardwareBack(sheet !== "none") === "leave") {
        return false;
      }
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [goBack, sheet]);

  useEffect(() => {
    if (sheet === "none") {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const node = findNodeHandle(sheetTitleRef.current);
      if (node) {
        AccessibilityInfo.setAccessibilityFocus(node);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [sheet]);

  const view = presentSettings({ authStatus, drafts, phase, statusKnown });
  const account = settingsAccount({ authStatus, bootstrapEmail, fallbackEmail });
  const syncLabel = settingsSyncLabel(view.syncKind);
  const syncBusy = phase === "synchronizing";
  settingsAnalyticsProperties();

  async function onSynchronize() {
    if (settingsActionBlocked(busy.current || !view.showSynchronize)) {
      return;
    }
    busy.current = true;
    setPhase("synchronizing");
    const result = await synchronizeNow();
    busy.current = false;
    if (!result.ok) {
      setPhase(result.reason === "conflict" ? "conflict" : "failed");
    } else {
      setPhase("idle");
    }
    await refreshDrafts();
  }

  async function openSignOut() {
    if (settingsActionBlocked(busy.current)) {
      return;
    }
    const status = await refreshDrafts();
    setSheet(settingsSignOutSheet(status, LOCAL_DRAFT_PERSISTENCE_IMPLEMENTED));
  }

  async function choose(choice: SignOutChoice) {
    if (settingsSheetStays(choice) || !signOutChoiceProceeds(choice)) {
      closeSheet();
      return;
    }
    if (settingsActionBlocked(busy.current)) {
      return;
    }
    busy.current = true;
    setSigningOut(true);
    try {
      await signOut(choice);
    } finally {
      busy.current = false;
      setSigningOut(false);
      setSheet("none");
    }
  }

  const rowHint = view.offline
    ? {
        plan: copy.settingsPlanOffline,
        support: copy.settingsSupportOffline,
        export: copy.settingsExportOffline,
      }
    : {
        plan: copy.settingsPlanHint,
        support: copy.settingsSupportHint,
        export: copy.settingsExportHint,
      };

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 22) },
        ]}
      >
        <Text accessibilityRole="header" style={styles.title}>
          {copy.settingsTitle}
        </Text>
        <Text style={styles.subtitle}>{copy.settingsSubtitle}</Text>
        {view.offline ? (
          <View accessibilityLabel={copy.offlineCached} accessibilityLiveRegion="polite" style={styles.notice}>
            <Text style={styles.noticeTitle}>{copy.settingsOfflineTitle}</Text>
            <Text style={styles.noticeBody}>{copy.settingsOfflineBody}</Text>
          </View>
        ) : null}
        {view.accessExpired ? (
          <Text accessibilityLiveRegion="polite" style={styles.noticeBody}>
            {copy.accessExpired}
          </Text>
        ) : null}
        {view.showAccount && (account.email || syncLabel) ? (
          <View style={styles.card}>
            {account.email ? (
              <View style={styles.identity}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarLabel}>{account.initial}</Text>
                </View>
                <View style={styles.identityCopy}>
                  <Text style={styles.accountTitle}>{copy.settingsAccount}</Text>
                  <Text style={styles.email}>{account.email}</Text>
                </View>
              </View>
            ) : null}
            {syncLabel ? (
              <View accessibilityLiveRegion="polite" style={styles.syncRow}>
                <View style={[styles.dot, { backgroundColor: syncDot(view.syncKind) }]} />
                <Text style={styles.syncText}>{syncLabel}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {view.syncKind === "unsynchronized" && !view.offline ? (
          <View accessibilityLiveRegion="polite" style={styles.notice}>
            <Text style={styles.noticeTitle}>{copy.settingsDraftsTitle}</Text>
            <Text style={styles.noticeBody}>
              {view.showSynchronize ? copy.settingsDraftsBody : copy.settingsSyncUnavailable}
            </Text>
          </View>
        ) : null}
        {view.showSynchronize ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={syncBusy ? copy.settingsSynchronizing : copy.synchronizeNow}
            accessibilityState={{ disabled: syncBusy, busy: syncBusy }}
            disabled={syncBusy}
            onPress={() => void onSynchronize()}
            style={[styles.syncButton, view.syncKind === "unsynchronized" ? styles.syncFilled : styles.syncOutline]}
          >
            <Text style={[styles.syncButtonLabel, view.syncKind === "unsynchronized" ? styles.syncFilledLabel : null]}>
              {syncBusy || view.syncKind === "failed" || view.syncKind === "conflict"
                ? syncBusy
                  ? copy.settingsSynchronizing
                  : copy.settingsTrySync
                : copy.synchronizeNow}
            </Text>
          </Pressable>
        ) : null}
        {view.showRows ? (
          <View style={styles.rows}>
            <SettingsRow
              hint={rowHint.plan}
              icon="◈"
              label={copy.subscriptionTitle}
              onPress={() => router.push(settingsPlanPath())}
            />
            <SettingsRow
              hint={rowHint.support}
              icon="?"
              label={copy.supportTitle}
              onPress={() => router.push(settingsSupportPath())}
            />
            <SettingsRow
              hint={rowHint.export}
              icon="⇩"
              label={copy.exportTitle}
              onPress={() => router.push(settingsExportPath())}
            />
          </View>
        ) : null}
        <View style={styles.spacer} />
        {view.syncKind === "conflict" || view.syncKind === "failed" ? (
          <View accessibilityLiveRegion="assertive" style={styles.notice}>
            <Text style={styles.noticeTitle}>{copy.settingsCouldNotSync}</Text>
            <Text style={styles.noticeBody}>
              {view.syncKind === "conflict" ? copy.synchronizeConflict : copy.synchronizeFailed}
            </Text>
          </View>
        ) : null}
        {auth.error &&
        !(view.syncKind === "conflict" && auth.error === copy.synchronizeConflict) &&
        !(view.syncKind === "failed" && auth.error === copy.synchronizeFailed) ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error}>
            {auth.error}
          </Text>
        ) : null}
        {view.showSignOut ? (
          <Pressable
            ref={signOutRef}
            accessibilityRole="button"
            accessibilityLabel={copy.signOut}
            accessibilityState={{ disabled: signingOut, busy: signingOut }}
            disabled={signingOut}
            onPress={() => void openSignOut()}
            style={styles.signOut}
          >
            <Text style={styles.signOutLabel}>{copy.signOut}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      <Modal animationType="slide" onRequestClose={closeSheet} transparent visible={sheet !== "none"}>
        <Pressable accessibilityLabel={copy.staySignedIn} onPress={closeSheet} style={styles.scrim}>
          <Pressable
            accessibilityViewIsModal
            onPress={() => undefined}
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 24) }]}
          >
            <View style={styles.handle} />
            <Text ref={sheetTitleRef} accessibilityRole="header" style={styles.sheetTitle}>
              {sheet === "confirm" ? copy.signOutConfirm : copy.unsyncedTitle}
            </Text>
            <Text style={styles.sheetBody}>
              {sheet === "confirm"
                ? copy.settingsSignOutBody
                : sheet === "unsynced"
                  ? copy.settingsUnsyncedSheetBody
                  : copy.settingsUnavailableSheetBody}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.staySignedIn}
              accessibilityState={{ disabled: signingOut }}
              disabled={signingOut}
              onPress={() => void choose("stay")}
              style={styles.stay}
            >
              <Text style={styles.stayLabel}>{copy.staySignedIn}</Text>
            </Pressable>
            {sheet === "unsynced" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.synchronize}
                accessibilityState={{ disabled: signingOut, busy: signingOut }}
                disabled={signingOut}
                onPress={() => void choose("synchronize")}
                style={styles.syncFilled}
              >
                <Text style={styles.syncFilledLabel}>{copy.synchronize}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={sheet === "confirm" ? copy.signOut : copy.discardAndSignOut}
              accessibilityState={{ disabled: signingOut, busy: signingOut }}
              disabled={signingOut}
              onPress={() => void choose(sheet === "confirm" ? "confirm" : "discard")}
              style={styles.signOut}
            >
              <Text style={styles.signOutLabel}>{sheet === "confirm" ? copy.signOut : copy.discardAndSignOut}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function SettingsRow({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: string;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.row}
    >
      <View style={styles.rowIcon}>
        <Text style={styles.rowIconLabel}>{icon}</Text>
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function syncDot(kind: string): string {
  if (kind === "synchronized") return SYNCED;
  if (kind === "unsynchronized") return PENDING;
  if (kind === "failed" || kind === "conflict") return DANGER;
  return MUTED;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  atmosphere: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "#E3EDFC",
    top: -55,
    right: -20,
  },
  content: { flexGrow: 1, paddingHorizontal: SETTINGS_GUTTER, gap: 14 },
  title: { color: TITLE, fontSize: 29, fontWeight: "700", lineHeight: 41 },
  subtitle: { color: MUTED, fontSize: 12, lineHeight: 17 },
  card: {
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 10,
  },
  identity: { flexDirection: "row", gap: 10, alignItems: "center" },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLabel: { color: "#FFFFFF", fontSize: 18, fontWeight: "700" },
  identityCopy: { flex: 1, gap: 2 },
  accountTitle: { color: TITLE, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  email: { color: MUTED, fontSize: 12, lineHeight: 17 },
  syncRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 17 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  syncText: { color: MUTED, fontSize: 12, fontWeight: "500", lineHeight: 17, flexShrink: 1 },
  notice: {
    backgroundColor: WARN,
    borderColor: LINE,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  noticeTitle: { color: TITLE, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  noticeBody: { color: MUTED, fontSize: 12, lineHeight: 17 },
  syncButton: {
    minHeight: SETTINGS_ACTION_PT,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  syncOutline: { backgroundColor: colors.surface, borderColor: LINE, borderWidth: 1 },
  syncFilled: {
    minHeight: SETTINGS_ACTION_PT,
    borderRadius: 17,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  syncButtonLabel: { color: PRIMARY, fontSize: 15, fontWeight: "600", lineHeight: 21 },
  syncFilledLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", lineHeight: 21 },
  rows: { gap: 9 },
  row: {
    minHeight: 68,
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    borderRadius: 18,
    paddingLeft: 14,
    paddingRight: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: INFO,
    alignItems: "center",
    justifyContent: "center",
  },
  rowIconLabel: { color: PRIMARY, fontSize: 17, fontWeight: "500" },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { color: TITLE, fontSize: 14, fontWeight: "600", lineHeight: 20 },
  rowHint: { color: MUTED, fontSize: 11, lineHeight: 15 },
  chevron: { color: MUTED, fontSize: 24, lineHeight: 34 },
  spacer: { flexGrow: 1, minHeight: 16 },
  error: { color: DANGER, fontSize: 13, lineHeight: 18 },
  signOut: {
    minHeight: SETTINGS_ACTION_PT,
    borderRadius: 17,
    backgroundColor: DANGER_BG,
    borderColor: DANGER_LINE,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  signOutLabel: { color: DANGER, fontSize: 15, fontWeight: "600", lineHeight: 21, textAlign: "center" },
  scrim: { flex: 1, backgroundColor: "rgba(20,23,33,0.36)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 10,
    paddingHorizontal: SETTINGS_GUTTER,
    gap: 12,
  },
  handle: { width: 42, height: 4, borderRadius: 2, backgroundColor: LINE },
  sheetTitle: { color: TITLE, fontSize: 20, fontWeight: "700", lineHeight: 28 },
  sheetBody: { color: MUTED, fontSize: 13, lineHeight: 18 },
  stay: {
    minHeight: SETTINGS_ACTION_PT,
    minWidth: SETTINGS_TARGET_MIN,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  stayLabel: { color: PRIMARY, fontSize: 15, fontWeight: "600", lineHeight: 21 },
});
