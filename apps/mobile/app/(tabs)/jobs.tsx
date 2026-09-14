import { StyleSheet, Text, View } from "react-native";
import { copy } from "../../src/i18n/en.ts";
import { useAuth } from "../../src/session/AuthProvider.tsx";
import { colors, space, type } from "../../src/theme.ts";

export default function JobsScreen() {
  const auth = useAuth();
  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        {copy.jobsTitle}
      </Text>
      {auth.snapshot.status === "offline_cached" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.offlineCached}
        </Text>
      ) : null}
      <Text style={styles.empty}>{copy.jobsEmpty}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  banner: { color: colors.navy, fontSize: type.secondary },
  empty: { color: colors.secondary, fontSize: type.body, marginTop: space.gutter },
});
