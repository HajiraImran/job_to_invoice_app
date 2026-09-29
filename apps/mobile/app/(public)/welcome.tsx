import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, space, type } from "../../src/theme.ts";
import { BrandLogo } from "../../src/welcome/BrandLogo.tsx";
import { WelcomeAtmosphere } from "../../src/welcome/WelcomeAtmosphere.tsx";
import { WelcomeQuotePreview } from "../../src/welcome/WelcomeQuotePreview.tsx";
import {
  presentWelcomeSample,
  presentWelcomeScreen,
  welcomeLayoutSpec,
} from "../../src/welcome/presentation.ts";

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sample = presentWelcomeSample();
  const screen = presentWelcomeScreen();
  const layout = welcomeLayoutSpec();

  return (
    <View style={styles.root}>
      <WelcomeAtmosphere />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + layout.gutter,
            paddingBottom: insets.bottom + layout.gutter,
            paddingHorizontal: layout.gutter,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        style={styles.screen}
      >
        <View
          accessible
          accessibilityLabel={screen.logoLabel}
          style={styles.brandRow}
        >
          <BrandLogo decorative size={40} />
        </View>

        <Text accessibilityRole="header" style={styles.title}>
          {screen.heading}
        </Text>
        <Text style={styles.body}>{screen.supportingText}</Text>

        <View style={styles.previewSlot}>
          <WelcomeQuotePreview sample={sample} />
        </View>

        <Pressable
          accessibilityLabel={screen.primaryLabel}
          accessibilityRole="button"
          onPress={() => router.push(screen.createHref)}
          style={[
            styles.button,
            {
              backgroundColor: layout.primaryActionColor,
              minHeight: layout.primaryButtonMinHeight,
            },
          ]}
        >
          <Text style={styles.buttonLabel}>{screen.primaryAction}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={screen.secondaryLabel}
          accessibilityRole="button"
          onPress={() => router.push(screen.signInHref)}
          style={styles.signInHit}
        >
          <Text style={styles.link}>{screen.secondaryAction}</Text>
        </Pressable>
        <Text style={styles.terms}>{screen.footer}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: "transparent" },
  content: { gap: space.scale, flexGrow: 1 },
  brandRow: {
    alignSelf: "flex-start",
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
  },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.secondary, fontSize: type.body },
  previewSlot: {
    flexGrow: 1,
    justifyContent: "center",
    marginVertical: space.scale,
  },
  button: {
    minHeight: 56,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.gutter,
    marginTop: space.scale,
  },
  buttonLabel: { color: colors.surface, fontSize: type.body, fontWeight: "600", textAlign: "center" },
  signInHit: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  link: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  terms: { color: colors.secondary, fontSize: type.secondary, marginTop: "auto", textAlign: "center" },
});
