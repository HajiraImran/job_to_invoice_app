import { maskEmail } from "@job-to-invoice/schemas";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { copy } from "../../src/i18n/en.ts";
import { bootstrapFailureScreenCopy } from "../../src/session/bootstrap.ts";
import { useAuth } from "../../src/session/AuthProvider.tsx";
import { canSubmitCode } from "../../src/session/logic.ts";
import { colors, space, type } from "../../src/theme.ts";

export default function VerifyScreen() {
  const auth = useAuth();
  const email = auth.snapshot.emailDisplay ?? auth.emailDisplay;
  const bootstrapFailed = auth.snapshot.status === "bootstrap_error";
  const bootstrapCopy = bootstrapFailureScreenCopy(auth.snapshot.supportCode ?? "BOOTSTRAP_UNKNOWN");
  const disabled = bootstrapFailed || !canSubmitCode(auth.code, auth.snapshot.verifyFailures ?? 0, auth.submitting);
  const autoSubmitted = useRef("");

  useEffect(() => {
    if (bootstrapFailed || disabled || autoSubmitted.current === auth.code) {
      return;
    }
    autoSubmitted.current = auth.code;
    void auth.verifyCode();
  }, [auth, bootstrapFailed, disabled]);

  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.verifyTitle}
      </Text>
      <Text style={styles.body}>
        {copy.codeSent} {maskEmail(email ?? "")}
      </Text>
      {bootstrapFailed ? (
        <>
          <Text accessibilityLiveRegion="assertive" style={styles.error}>
            {auth.error ?? bootstrapCopy.message}
          </Text>
          <Text style={styles.supportCode}>{bootstrapCopy.supportLine}</Text>
          <Pressable
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
          <Text nativeID="code-label" style={styles.label}>
            {copy.codeLabel}
          </Text>
          <TextInput
            accessibilityLabel={copy.codeLabel}
            autoComplete="one-time-code"
            keyboardType="number-pad"
            maxLength={6}
            onChangeText={(value) => auth.setCode(value.replace(/\D/g, "").slice(0, 6))}
            style={styles.input}
            textContentType="oneTimeCode"
            value={auth.code}
          />
          {auth.error ? (
            <Text accessibilityLiveRegion="assertive" style={styles.error}>
              {auth.error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: auth.submitting, disabled }}
            disabled={disabled}
            onPress={() => {
              void auth.verifyCode();
            }}
            style={[styles.button, disabled ? styles.buttonDisabled : null]}
          >
            <Text style={styles.buttonLabel}>{auth.submitting ? copy.verifying : copy.verify}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={auth.resendSeconds > 0 || auth.submitting}
            onPress={() => {
              void auth.sendCode();
            }}
          >
            <Text style={styles.link}>
              {auth.resendSeconds > 0 ? `Resend in ${auth.resendSeconds}s` : copy.resend}
            </Text>
          </Pressable>
        </>
      )}
      <Pressable accessibilityRole="button" onPress={auth.changeEmail}>
        <Text style={styles.link}>{copy.changeEmail}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.secondary, fontSize: type.body },
  label: { color: colors.text, fontSize: type.secondary, marginTop: space.scale },
  input: {
    minHeight: 44,
    letterSpacing: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.section,
    color: colors.text,
    backgroundColor: "#FFFFFF",
  },
  error: { color: colors.danger, fontSize: type.secondary },
  supportCode: { color: colors.secondary, fontSize: type.secondary },
  button: {
    minHeight: 44,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "600" },
  link: { color: colors.navy, fontSize: type.body, minHeight: 44, paddingTop: 12 },
});
