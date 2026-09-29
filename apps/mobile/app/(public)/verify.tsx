import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthShieldMark } from "../../src/auth/AuthShieldMark.tsx";
import { VerifyCodeField } from "../../src/auth/VerifyCodeField.tsx";
import {
  AUTH_GUTTER,
  presentMaskedEmail,
  presentResendLabel,
  presentVerifyReady,
  presentVerifyScreen,
  sanitizeOwnerCode,
} from "../../src/auth/presentation.ts";
import { copy } from "../../src/i18n/en.ts";
import { bootstrapFailureScreenCopy } from "../../src/session/bootstrap.ts";
import { useAuth } from "../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../src/theme.ts";
import { PublicAtmosphere } from "../../src/ui/PublicAtmosphere.tsx";

export default function VerifyScreen() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const screen = presentVerifyScreen();
  const email = auth.snapshot.emailDisplay ?? auth.emailDisplay;
  const bootstrapFailed = auth.snapshot.status === "bootstrap_error";
  const bootstrapCopy = bootstrapFailureScreenCopy(auth.snapshot.supportCode ?? "BOOTSTRAP_UNKNOWN");
  const verifyReady = presentVerifyReady(auth.code, auth.snapshot.verifyFailures ?? 0, auth.submitting);
  const resendAvailable = auth.resendSeconds <= 0 && !auth.submitting;
  const resendLabel = presentResendLabel(auth.resendSeconds);
  const [resendNotice, setResendNotice] = useState<string | undefined>();

  function returnToEmail() {
    setResendNotice(undefined);
    auth.changeEmail();
  }

  return (
    <View style={styles.root}>
      <PublicAtmosphere />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: insets.top + AUTH_GUTTER,
              paddingBottom: insets.bottom + AUTH_GUTTER,
              paddingHorizontal: AUTH_GUTTER,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          style={styles.flex}
        >
          <Pressable
            accessibilityLabel={screen.backLabel}
            accessibilityRole="button"
            onPress={returnToEmail}
            style={styles.backHit}
          >
            <Text style={styles.backLabel}>{screen.backLabel}</Text>
          </Pressable>

          <View style={styles.contextRow}>
            <Text style={styles.context}>{screen.context}</Text>
            <View style={styles.safetyChip}>
              <Text style={styles.safety}>{screen.safetyLabel}</Text>
            </View>
          </View>

          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={styles.markWrap}
          >
            <AuthShieldMark />
          </View>

          <Text accessibilityRole="header" style={styles.title}>
            {screen.heading}
          </Text>
          <Text style={styles.body}>{screen.instruction}</Text>
          <Text style={styles.masked}>{presentMaskedEmail(email ?? "")}</Text>
          <Text style={styles.hint}>{screen.pasteHint}</Text>

          {bootstrapFailed ? (
            <>
              <Text accessibilityLiveRegion="assertive" style={styles.error}>
                {auth.error ?? bootstrapCopy.message}
              </Text>
              <Text style={styles.supportCode}>{bootstrapCopy.supportLine}</Text>
              <Pressable
                accessibilityLabel={auth.submitting ? copy.verifying : copy.retry}
                accessibilityRole="button"
                accessibilityState={{ busy: auth.submitting }}
                disabled={auth.submitting}
                onPress={() => {
                  void auth.refreshBootstrap();
                }}
                style={[styles.button, auth.submitting ? styles.buttonDisabled : null]}
              >
                <Text style={styles.buttonLabel}>{auth.submitting ? copy.verifying : copy.retry}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <VerifyCodeField
                disabled={auth.submitting}
                hint={screen.codeHint}
                label={screen.codeLabel}
                onChange={auth.setCode}
                value={sanitizeOwnerCode(auth.code)}
              />
              {auth.error ? (
                <Text accessibilityLiveRegion="assertive" style={styles.error}>
                  {auth.error}
                </Text>
              ) : null}
              {resendNotice ? (
                <Text accessibilityLiveRegion="polite" style={styles.notice}>
                  {resendNotice}
                </Text>
              ) : null}
              <Pressable
                accessibilityLabel={auth.submitting ? screen.verifyingAction : screen.primaryAction}
                accessibilityRole="button"
                accessibilityState={{ busy: auth.submitting, disabled: !verifyReady }}
                disabled={!verifyReady}
                onPress={() => {
                  if (!presentVerifyReady(auth.code, auth.snapshot.verifyFailures ?? 0, auth.submitting)) {
                    return;
                  }
                  void auth.verifyCode();
                }}
                style={[styles.button, !verifyReady ? styles.buttonDisabled : null]}
              >
                <Text style={styles.buttonLabel}>
                  {auth.submitting ? screen.verifyingAction : screen.primaryAction}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={resendLabel}
                accessibilityRole="button"
                accessibilityState={{ busy: auth.submitting, disabled: !resendAvailable }}
                disabled={!resendAvailable}
                onPress={() => {
                  void auth.sendCode().then((result) => {
                    setResendNotice(result.ok ? screen.instruction : undefined);
                  });
                }}
                style={styles.linkHit}
              >
                <Text style={styles.link}>{resendLabel}</Text>
              </Pressable>
            </>
          )}
          <Pressable
            accessibilityLabel={screen.changeEmailLabel}
            accessibilityRole="button"
            onPress={returnToEmail}
            style={styles.linkHit}
          >
            <Text style={styles.link}>{screen.changeEmailLabel}</Text>
          </Pressable>
          <Text style={styles.expiry}>{screen.expiryNote}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { gap: space.scale, flexGrow: 1 },
  backHit: { minHeight: 44, minWidth: 44, justifyContent: "center", alignSelf: "flex-start" },
  backLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  contextRow: { gap: space.scale },
  context: { color: colors.navy, fontSize: type.secondary, fontWeight: "700", letterSpacing: 0.4 },
  safetyChip: {
    alignSelf: "flex-start",
    backgroundColor: colors.infoTint,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 32,
  },
  safety: { color: colors.success, fontSize: type.secondary, fontWeight: "600" },
  markWrap: { alignItems: "center", marginVertical: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.secondary, fontSize: type.body },
  masked: { color: colors.text, fontSize: type.body, fontWeight: "600" },
  hint: { color: colors.secondary, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  notice: { color: colors.success, fontSize: type.secondary },
  supportCode: { color: colors.secondary, fontSize: type.secondary },
  button: {
    minHeight: 56,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.gutter,
    marginTop: space.scale,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: colors.surface, fontSize: type.body, fontWeight: "600", textAlign: "center" },
  linkHit: { minHeight: 44, justifyContent: "center" },
  link: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  expiry: { color: colors.secondary, fontSize: type.secondary, marginTop: "auto", textAlign: "center" },
});
