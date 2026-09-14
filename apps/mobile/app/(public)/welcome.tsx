import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { copy } from "../../src/i18n/en.ts";
import { colors, space, type } from "../../src/theme.ts";

export default function WelcomeScreen() {
  const router = useRouter();
  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.appName}
      </Text>
      <Text style={styles.body}>{copy.welcomePromise}</Text>
      <Text style={styles.sample}>{copy.welcomeSample}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/(public)/sign-in")}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{copy.createFirstQuote}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => router.push("/(public)/sign-in")}>
        <Text style={styles.link}>{copy.signIn}</Text>
      </Pressable>
      <Text style={styles.terms}>{copy.terms}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700", marginTop: 48 },
  body: { color: colors.text, fontSize: type.body },
  sample: { color: colors.secondary, fontSize: type.secondary },
  button: {
    minHeight: 44,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.gutter,
  },
  buttonLabel: { color: "#FFFFFF", fontSize: type.body, fontWeight: "600" },
  link: { color: colors.navy, fontSize: type.body, minHeight: 44, paddingTop: 12 },
  terms: { color: colors.secondary, fontSize: type.secondary, marginTop: "auto" },
});
