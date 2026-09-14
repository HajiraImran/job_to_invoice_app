import { parseOwnerEmail } from "@job-to-invoice/schemas";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { copy } from "../../src/i18n/en.ts";
import { useAuth } from "../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../src/theme.ts";

export default function SignInScreen() {
  const auth = useAuth();
  const parsed = parseOwnerEmail(auth.emailDisplay);
  const disabled = auth.submitting || !parsed.ok;

  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.signIn}
      </Text>
      <Text style={styles.body}>{copy.passwordless}</Text>
      <Text nativeID="email-label" style={styles.label}>
        {copy.emailLabel}
      </Text>
      <TextInput
        accessibilityLabel={copy.emailLabel}
        accessibilityLabelledBy="email-label"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
        onChangeText={auth.setEmailDisplay}
        style={styles.input}
        textContentType="emailAddress"
        value={auth.emailDisplay}
      />
      {parsed.ok === false && auth.emailDisplay.trim().length > 0 ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {copy.invalidEmail}
        </Text>
      ) : null}
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
          void auth.sendCode();
        }}
        style={[styles.button, disabled ? styles.buttonDisabled : null]}
      >
        <Text style={styles.buttonLabel}>{auth.submitting ? copy.sendingCode : copy.sendCode}</Text>
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
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: "#FFFFFF",
  },
  error: { color: colors.danger, fontSize: type.secondary },
  button: {
    minHeight: 44,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.scale,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "600" },
});
