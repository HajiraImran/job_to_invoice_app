import { StyleSheet, View } from "react-native";
import { colors } from "../theme.ts";

/** Decorative shield for S03. Hidden from assistive technology by the parent. */
export function AuthShieldMark() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.badge}
    >
      <View style={styles.shield}>
        <View style={styles.checkShort} />
        <View style={styles.checkLong} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 124,
    height: 124,
    borderRadius: 62,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.infoTint,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.text,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  shield: {
    width: 56,
    height: 64,
    borderRadius: 12,
    backgroundColor: colors.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  checkShort: {
    position: "absolute",
    width: 4,
    height: 12,
    borderRadius: 2,
    backgroundColor: colors.surface,
    transform: [{ rotate: "-45deg" }, { translateX: -7 }, { translateY: 4 }],
  },
  checkLong: {
    position: "absolute",
    width: 4,
    height: 20,
    borderRadius: 2,
    backgroundColor: colors.surface,
    transform: [{ rotate: "45deg" }, { translateX: 4 }, { translateY: 0 }],
  },
});
