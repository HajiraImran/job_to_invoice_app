import { StyleSheet, View } from "react-native";
import { colors } from "../theme.ts";

/** Soft blue and mint lighting. Decorative only; no animation. */
export function PublicAtmosphere() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <View style={styles.blueGlow} />
      <View style={styles.mintGlow} />
      <View style={styles.infoWash} />
    </View>
  );
}

const styles = StyleSheet.create({
  blueGlow: {
    position: "absolute",
    top: -80,
    right: -60,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "#3B82F6",
    opacity: 0.12,
  },
  mintGlow: {
    position: "absolute",
    bottom: 80,
    left: -90,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: colors.success,
    opacity: 0.1,
  },
  infoWash: {
    position: "absolute",
    top: 120,
    left: 24,
    right: 24,
    height: 220,
    borderRadius: 110,
    backgroundColor: colors.infoTint,
    opacity: 0.55,
  },
});
