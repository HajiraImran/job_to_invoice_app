import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../src/i18n/en.ts";
import { colors, space, type } from "../../src/theme.ts";
import { presentWelcomeSample, welcomePrimaryActions } from "../../src/welcome/presentation.ts";

const PRIMARY_BUTTON_MIN_HEIGHT = 48;

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sample = presentWelcomeSample();
  const actions = welcomePrimaryActions();

  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.gutter, paddingBottom: insets.bottom + space.gutter },
      ]}
      style={styles.screen}
    >
      <Text accessibilityRole="header" style={styles.title}>
        {copy.appName}
      </Text>
      <Text style={styles.body}>{copy.welcomePromise}</Text>
      <View
        accessibilityLabel={`${sample.title}. ${sample.cannotSendLabel}`}
        accessibilityRole="summary"
        style={styles.sampleCard}
      >
        <Text style={styles.sampleTitle}>{sample.title}</Text>
        <Text style={styles.sampleMeta}>{sample.businessName}</Text>
        <Text style={styles.sampleMeta}>{sample.customerName}</Text>
        <Text style={styles.sampleJob}>{sample.jobTitle}</Text>
        {sample.lines.map((line) => (
          <View key={line.description} style={styles.sampleLine}>
            <Text style={styles.sampleLineText}>
              {line.description} · {line.quantityLabel}
            </Text>
            <Text style={styles.sampleLineText}>{line.amountLabel}</Text>
          </View>
        ))}
        <Text style={styles.sampleTotal}>{sample.totalLabel}</Text>
        <Text style={styles.sampleCannotSend}>{sample.cannotSendLabel}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(actions.href)}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{actions.createFirstQuote}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => router.push(actions.href)}>
        <Text style={styles.link}>{actions.signIn}</Text>
      </Pressable>
      <Text style={styles.terms}>{copy.terms}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: space.gutter, gap: space.scale, flexGrow: 1 },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.text, fontSize: type.body },
  sampleCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    backgroundColor: "#FFFFFF",
    padding: space.gutter,
    gap: space.scale,
  },
  sampleTitle: { color: colors.text, fontSize: type.section, fontWeight: "600" },
  sampleMeta: { color: colors.secondary, fontSize: type.secondary },
  sampleJob: { color: colors.text, fontSize: type.body, fontWeight: "600" },
  sampleLine: { flexDirection: "row", justifyContent: "space-between", gap: space.scale },
  sampleLineText: { color: colors.text, fontSize: type.body, flexShrink: 1 },
  sampleTotal: { color: colors.text, fontSize: type.body, fontWeight: "700" },
  sampleCannotSend: { color: colors.secondary, fontSize: type.secondary },
  button: {
    minHeight: PRIMARY_BUTTON_MIN_HEIGHT,
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
