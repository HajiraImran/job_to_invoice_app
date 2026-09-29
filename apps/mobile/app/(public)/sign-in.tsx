import { parseOwnerEmail } from "@job-to-invoice/schemas";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthLockMark } from "../../src/auth/AuthLockMark.tsx";
import { AUTH_GUTTER, presentEmailFieldError, presentSignInScreen } from "../../src/auth/presentation.ts";
import { useAuth } from "../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../src/theme.ts";
import { PublicAtmosphere } from "../../src/ui/PublicAtmosphere.tsx";

export default function SignInScreen() {
  const auth = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const screen = presentSignInScreen();
  const parsed = parseOwnerEmail(auth.emailDisplay);
  const fieldError = presentEmailFieldError(auth.emailDisplay);
  const disabled = auth.submitting || !parsed.ok;

  function goBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(screen.backHref);
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
            onPress={goBack}
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
            style={styles.lockWrap}
          >
            <AuthLockMark />
          </View>

          <Text accessibilityRole="header" style={styles.title}>
            {screen.heading}
          </Text>
          <Text style={styles.body}>{screen.supportingText}</Text>
          <Text style={styles.hint}>{screen.codeHint}</Text>

          <Text nativeID="email-label" style={styles.label}>
            {screen.emailLabel}
          </Text>
          <TextInput
            accessibilityHint={screen.codeHint}
            accessibilityLabel={screen.emailLabel}
            accessibilityLabelledBy="email-label"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            keyboardType="email-address"
            maxLength={254}
            onChangeText={auth.setEmailDisplay}
            style={styles.input}
            textContentType="emailAddress"
            value={auth.emailDisplay}
          />
          {fieldError ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {fieldError}
            </Text>
          ) : null}
          {auth.error ? (
            <Text accessibilityLiveRegion="assertive" style={styles.error}>
              {auth.error}
            </Text>
          ) : null}
          <Pressable
            accessibilityLabel={auth.submitting ? screen.sendingAction : screen.primaryAction}
            accessibilityRole="button"
            accessibilityState={{ busy: auth.submitting, disabled }}
            disabled={disabled}
            onPress={() => {
              void auth.sendCode();
            }}
            style={[
              styles.button,
              {
                backgroundColor: screen.primaryActionColor,
                minHeight: screen.primaryButtonMinHeight,
              },
              disabled ? styles.buttonDisabled : null,
            ]}
          >
            <Text style={styles.buttonLabel}>{auth.submitting ? screen.sendingAction : screen.primaryAction}</Text>
          </Pressable>
          <Text style={styles.privacy}>{screen.privacyNote}</Text>
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
  lockWrap: { alignItems: "center", marginVertical: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.secondary, fontSize: type.body },
  hint: { color: colors.secondary, fontSize: type.secondary },
  label: { color: colors.text, fontSize: type.secondary, marginTop: space.scale },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  error: { color: colors.danger, fontSize: type.secondary },
  button: {
    minHeight: 56,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.gutter,
    marginTop: space.scale,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: colors.surface, fontSize: type.body, fontWeight: "600", textAlign: "center" },
  privacy: { color: colors.secondary, fontSize: type.secondary, marginTop: "auto", textAlign: "center" },
});
