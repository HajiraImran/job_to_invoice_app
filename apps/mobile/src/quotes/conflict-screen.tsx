import { useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { secureRandomUUID } from "../crypto/uuid.ts";
import { getLocalDraft } from "../drafts/repository.ts";
import { copy } from "../i18n/en.ts";
import { jobDetailPath } from "../jobs/routes.ts";
import { retainOrCreateSetupIdempotencyKey } from "../setup/idempotency.ts";
import { useAuth } from "../session/AuthProvider.tsx";
import {
  noteServerDraftChanged,
  readFullServerDraft,
  recoverableLocalJson,
  resolveDraftConflict,
  saveRecoverableLocalCopy,
} from "../sync/conflict.ts";
import { colors } from "../theme.ts";
import { conflictActionBlocked, conflictHardwareBack, type ConflictSurface } from "./conflict-presentation.ts";

const PRIMARY = "#464B71";
const TITLE = "#1F2430";
const MUTED = "#636B7D";
const LINE = "#E2E5EC";
const CHIP_BG = "#FFF6E3";
const CHIP = "#8F5C0D";
const ICON_BG = "#EBF2FF";
const PAUSE_BG = "#EDF4FF";
const PAUSE_LINE = "#D1E5FF";
const OFFLINE_LINE = "#F2CC80";
const DISABLED_BG = "#F2F4F6";
const DISABLED_LINE = "#D1D4DE";
const DISABLED = "#8C91A1";

export function QuoteConflictScreen(input: {
  jobId: string;
  draftId?: string;
  surface: ConflictSurface;
  onReload: () => Promise<void>;
}) {
  const auth = useAuth();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const busy = useRef(false);
  const refreshKey = useRef<string | undefined>(undefined);
  const copyId = useRef<string | undefined>(undefined);
  const errorRef = useRef<Text>(null);
  const [resolving, setResolving] = useState<"server" | "local" | null>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [ack, setAck] = useState<string | undefined>();
  const offline = input.surface === "offline_conflict";
  const expired = input.surface === "access_expired";

  const leave = useCallback(() => {
    if (conflictHardwareBack(input.surface) === "stay") {
      return;
    }
    router.replace(jobDetailPath(input.jobId));
  }, [input.jobId, input.surface, router]);

  useEffect(() => {
    const targets: Array<{ setOptions: (options: { tabBarStyle?: { display: "none" } }) => void }> = [];
    let parent = navigation.getParent() as
      | {
          setOptions: (options: { tabBarStyle?: { display: "none" } }) => void;
          getParent: () => unknown;
        }
      | undefined;
    while (parent && targets.length < 3) {
      targets.push(parent);
      const next = parent.getParent();
      parent =
        next && typeof next === "object" && "setOptions" in next && "getParent" in next
          ? (next as typeof parent)
          : undefined;
    }
    for (const target of targets) {
      target.setOptions({ tabBarStyle: { display: "none" } });
    }
    return () => {
      for (const target of targets) {
        target.setOptions({ tabBarStyle: undefined });
      }
    };
  }, [navigation]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      leave();
      return true;
    });
    return () => subscription.remove();
  }, [leave]);

  function focusError() {
    requestAnimationFrame(() => {
      const node = findNodeHandle(errorRef.current);
      if (node) {
        AccessibilityInfo.setAccessibilityFocus(node);
      }
    });
  }

  async function keepServer() {
    if (conflictActionBlocked(busy.current) || offline || expired || !input.draftId) {
      return;
    }
    busy.current = true;
    setResolving("server");
    setMessage(undefined);
    setAck(undefined);
    try {
      const session = auth.getSyncSessionDb();
      if (!session) {
        setMessage(copy.conflictKeepFailed);
        focusError();
        return;
      }
      refreshKey.current = retainOrCreateSetupIdempotencyKey(refreshKey.current);
      const result = await auth.runOwnerRequest<Record<string, unknown>>({
        path: `/v1/jobs/${input.jobId}/quote`,
        method: "POST",
        idempotencyKey: refreshKey.current,
      });
      if (!result.ok) {
        setMessage(copy.conflictKeepFailed);
        focusError();
        return;
      }
      const server = readFullServerDraft(result.data);
      if (!server) {
        setMessage(copy.conflictKeepFailed);
        focusError();
        return;
      }
      const prepared = await noteServerDraftChanged(session.db, {
        draftId: input.draftId,
        serverPayloadJson: server.payloadJson,
        serverVersion: server.version,
      });
      if (prepared === "server_changed") {
        setMessage(copy.conflictServerChanged);
        focusError();
        return;
      }
      await resolveDraftConflict(session.db, {
        draftId: input.draftId,
        choice: "keep_server",
        serverPayloadJson: server.payloadJson,
        serverVersion: server.version,
      });
      await input.onReload();
    } catch {
      setMessage(copy.conflictKeepFailed);
      focusError();
    } finally {
      busy.current = false;
      setResolving(null);
    }
  }

  async function saveLocal() {
    if (conflictActionBlocked(busy.current) || expired || !input.draftId) {
      return;
    }
    const session = auth.getSyncSessionDb();
    if (!session) {
      setMessage(copy.quoteStorageFailure);
      focusError();
      return;
    }
    busy.current = true;
    setResolving("local");
    setMessage(undefined);
    try {
      if (offline) {
        copyId.current = copyId.current ?? secureRandomUUID();
        await saveRecoverableLocalCopy(session.db, {
          sourceDraftId: input.draftId,
          copyDraftId: copyId.current,
        });
        setAck(copy.conflictCopySaved);
        return;
      }
      refreshKey.current = retainOrCreateSetupIdempotencyKey(refreshKey.current);
      const result = await auth.runOwnerRequest<Record<string, unknown>>({
        path: `/v1/jobs/${input.jobId}/quote`,
        method: "POST",
        idempotencyKey: refreshKey.current,
      });
      if (!result.ok) {
        setMessage(copy.conflictKeepFailed);
        focusError();
        return;
      }
      const server = readFullServerDraft(result.data);
      if (!server) {
        setMessage(copy.conflictKeepFailed);
        focusError();
        return;
      }
      const prepared = await noteServerDraftChanged(session.db, {
        draftId: input.draftId,
        serverPayloadJson: server.payloadJson,
        serverVersion: server.version,
      });
      if (prepared === "server_changed") {
        setMessage(copy.conflictServerChanged);
        focusError();
        return;
      }
      const local = await getLocalDraft(session.db, input.draftId);
      const payloadJson = local ? recoverableLocalJson(local) : null;
      if (!local || !payloadJson) {
        setMessage(copy.conflictKeepFailed);
        focusError();
        return;
      }
      copyId.current = copyId.current ?? secureRandomUUID();
      await resolveDraftConflict(session.db, {
        draftId: input.draftId,
        choice: "save_local_copy",
        serverPayloadJson: server.payloadJson,
        serverVersion: server.version,
        localCopy: {
          draftId: copyId.current,
          jobId: local.jobId,
          kind: local.kind,
          schemaVersion: local.schemaVersion,
          payloadJson,
          baseVersion: 1,
        },
      });
      await input.onReload();
    } catch {
      setMessage(copy.conflictKeepFailed);
      focusError();
    } finally {
      busy.current = false;
      setResolving(null);
    }
  }

  const keepDisabled = offline || resolving !== null;
  const saveDisabled = resolving !== null || !auth.getSyncSessionDb();

  return (
    <View style={styles.screen}>
      <View pointerEvents="none" style={styles.atmosphere} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 24) },
        ]}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel={copy.conflictBack}
            accessibilityRole="button"
            onPress={leave}
            style={styles.back}
          >
            <Text style={styles.backGlyph}>{"\u2039"}</Text>
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.headerTitle}>{copy.conflictHeader}</Text>
            <Text style={styles.headerHint}>
              {expired ? copy.conflictAccessHint : offline ? copy.conflictOfflineHint : copy.conflictHeaderHint}
            </Text>
          </View>
        </View>
        {expired ? (
          <View style={styles.expired}>
            <View style={styles.lock}>
              <Text style={styles.lockGlyph}>{"\u25A3"}</Text>
            </View>
            <Text accessibilityRole="header" style={styles.expiredTitle}>
              {copy.conflictSignInTitle}
            </Text>
            <Text accessibilityLiveRegion="polite" style={styles.expiredBody}>
              {copy.accessExpired}
            </Text>
            <View style={styles.privacy}>
              <Text style={styles.privacyTitle}>{copy.conflictHiddenTitle}</Text>
              <Text style={styles.privacyBody}>{copy.conflictHiddenBody}</Text>
            </View>
          </View>
        ) : (
          <>
            {offline ? (
              <View accessibilityLiveRegion="polite" style={styles.offline}>
                <Text style={styles.offlineTitle}>{copy.conflictOfflineTitle}</Text>
                <Text style={styles.offlineBody}>{copy.conflictOfflineBody}</Text>
              </View>
            ) : null}
            <Text accessibilityRole="header" style={styles.title}>
              {copy.conflictTitle}
            </Text>
            {offline ? null : <Text style={styles.choose}>{copy.conflictChoose}</Text>}
            <View accessibilityLiveRegion="assertive" style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.icon}>
                  <Text style={styles.iconGlyph}>{"\u2261"}</Text>
                </View>
                <View style={styles.chip}>
                  <Text style={styles.chipLabel}>{copy.conflictNeedsAttention}</Text>
                </View>
              </View>
              <Text accessibilityRole="alert" style={styles.sentence}>
                {copy.conflictBody}
              </Text>
              <Text style={styles.cardBody}>{copy.conflictUnpublished}</Text>
            </View>
            {offline ? null : (
              <View style={styles.pause}>
                <Text style={styles.pauseTitle}>{copy.conflictPublishPaused}</Text>
                <Text style={styles.pauseBody}>{copy.conflictPublishPausedBody}</Text>
              </View>
            )}
            <View style={styles.spacer} />
            {message ? (
              <Text ref={errorRef} accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.error}>
                {message}
              </Text>
            ) : null}
            {ack ? (
              <Text accessibilityLiveRegion="polite" style={styles.ack}>
                {ack}
              </Text>
            ) : null}
            {offline ? (
              <Pressable
                accessibilityLabel={copy.quoteSaveLocalCopy}
                accessibilityRole="button"
                accessibilityState={{ disabled: saveDisabled, busy: resolving === "local" }}
                disabled={saveDisabled}
                onPress={() => void saveLocal()}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{copy.quoteSaveLocalCopy}</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel={copy.quoteKeepServer}
                accessibilityRole="button"
                accessibilityState={{ disabled: keepDisabled, busy: resolving === "server" }}
                disabled={keepDisabled}
                onPress={() => void keepServer()}
                style={styles.primary}
              >
                <Text style={styles.primaryLabel}>{copy.quoteKeepServer}</Text>
              </Pressable>
            )}
            {offline ? (
              <Pressable
                accessibilityLabel={copy.quoteKeepServer}
                accessibilityRole="button"
                accessibilityState={{ disabled: true }}
                disabled
                style={styles.disabled}
              >
                <Text style={styles.disabledLabel}>{copy.quoteKeepServer}</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel={copy.quoteSaveLocalCopy}
                accessibilityRole="button"
                accessibilityState={{ disabled: saveDisabled, busy: resolving === "local" }}
                disabled={saveDisabled}
                onPress={() => void saveLocal()}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{copy.quoteSaveLocalCopy}</Text>
              </Pressable>
            )}
            <Text style={styles.footnote}>{offline ? copy.conflictOfflineKeep : copy.conflictLater}</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  atmosphere: {
    position: "absolute",
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: "#E3EDFC",
    top: -72,
    right: -73,
  },
  content: { flexGrow: 1, paddingHorizontal: 20, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 48 },
  back: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backGlyph: { color: TITLE, fontSize: 28, lineHeight: 32 },
  headerCopy: { flex: 1, gap: 2 },
  headerTitle: { color: TITLE, fontSize: 18, fontWeight: "700", lineHeight: 26 },
  headerHint: { color: MUTED, fontSize: 11, lineHeight: 16 },
  title: { color: TITLE, fontSize: 30, fontWeight: "700", lineHeight: 40 },
  choose: { color: MUTED, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    borderRadius: 22,
    padding: 20,
    gap: 14,
    shadowColor: "#2B334D",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 15,
    backgroundColor: ICON_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  iconGlyph: { color: PRIMARY, fontSize: 22, fontWeight: "600" },
  chip: { backgroundColor: CHIP_BG, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  chipLabel: { color: CHIP, fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  sentence: { color: TITLE, fontSize: 16, fontWeight: "600", lineHeight: 23 },
  cardBody: { color: MUTED, fontSize: 12, lineHeight: 17 },
  pause: {
    backgroundColor: PAUSE_BG,
    borderColor: PAUSE_LINE,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  pauseTitle: { color: PRIMARY, fontSize: 12, fontWeight: "600", lineHeight: 17 },
  pauseBody: { color: MUTED, fontSize: 11, lineHeight: 16 },
  offline: {
    backgroundColor: CHIP_BG,
    borderColor: OFFLINE_LINE,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 8,
  },
  offlineTitle: { color: TITLE, fontSize: 13, fontWeight: "600", lineHeight: 19 },
  offlineBody: { color: MUTED, fontSize: 11, lineHeight: 16 },
  spacer: { flexGrow: 1, minHeight: 12 },
  primary: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: PRIMARY,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", lineHeight: 22, textAlign: "center" },
  secondary: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderColor: PRIMARY,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  secondaryLabel: { color: PRIMARY, fontSize: 15, fontWeight: "600", lineHeight: 22, textAlign: "center" },
  disabled: {
    minHeight: 56,
    borderRadius: 18,
    backgroundColor: DISABLED_BG,
    borderColor: DISABLED_LINE,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  disabledLabel: { color: DISABLED, fontSize: 15, fontWeight: "600", lineHeight: 22, textAlign: "center" },
  footnote: { color: MUTED, fontSize: 11, lineHeight: 16, textAlign: "center" },
  error: { color: "#C23840", fontSize: 13, lineHeight: 18 },
  ack: { color: TITLE, fontSize: 13, lineHeight: 18 },
  expired: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingVertical: 48 },
  lock: {
    width: 88,
    height: 88,
    borderRadius: 28,
    backgroundColor: ICON_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  lockGlyph: { color: PRIMARY, fontSize: 36 },
  expiredTitle: { color: TITLE, fontSize: 28, fontWeight: "700", lineHeight: 40, textAlign: "center" },
  expiredBody: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: "center", maxWidth: 300 },
  privacy: {
    backgroundColor: colors.surface,
    borderColor: LINE,
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 6,
    width: "100%",
    maxWidth: 320,
  },
  privacyTitle: { color: TITLE, fontSize: 12, fontWeight: "600", lineHeight: 17, textAlign: "center" },
  privacyBody: { color: MUTED, fontSize: 11, lineHeight: 16, textAlign: "center" },
});
