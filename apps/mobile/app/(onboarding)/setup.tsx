import { Pressable, StyleSheet, Text, View } from "react-native";
import { copy } from "../../src/i18n/en.ts";
import { useAuth } from "../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../src/theme.ts";

export default function SetupGateScreen() {
  const auth = useAuth();
  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.setupTitle}
      </Text>
      <Text style={styles.body}>{copy.setupNext}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void auth.signOut("confirm");
        }}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>{copy.signOut}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  body: { color: colors.text, fontSize: type.body },
  button: {
    minHeight: 44,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.gutter,
  },
  buttonLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});
