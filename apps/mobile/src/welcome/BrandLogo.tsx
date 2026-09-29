import { StyleSheet, View } from "react-native";

const LOGO_INK = "#222E34";
const LOGO_CHECK = "#3B82F6";
const BASE = 48;

type BrandLogoProps = {
  size?: number;
  decorative?: boolean;
};

/**
 * Approved Job to Invoice mark. The SVG source lives at assets/brand/job-to-invoice-logo.svg.
 * Metro has no SVG transformer and react-native-svg is not installed, so the mark is drawn
 * with Views from the approved artwork colors and silhouette.
 */
export function BrandLogo({ size = BASE, decorative = false }: BrandLogoProps) {
  const s = size / BASE;
  return (
    <View
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? "no-hide-descendants" : "yes"}
      pointerEvents="none"
      style={[styles.root, { width: size, height: size }]}
    >
      <View
        style={[
          styles.document,
          {
            top: 5 * s,
            left: 14 * s,
            width: 24 * s,
            height: 28 * s,
            borderRadius: 4 * s,
          },
        ]}
      />
      <View
        style={[
          styles.fold,
          {
            top: 5 * s,
            left: 30 * s,
            borderBottomWidth: 8 * s,
            borderLeftWidth: 8 * s,
          },
        ]}
      />
      <View
        style={[
          styles.hook,
          {
            top: 26 * s,
            left: 9 * s,
            width: 22 * s,
            height: 16 * s,
            borderRadius: 11 * s,
          },
        ]}
      />
      <View
        style={[
          styles.checkShort,
          {
            top: 28 * s,
            left: 15 * s,
            width: 3 * s,
            height: 8 * s,
            borderRadius: 1.5 * s,
          },
        ]}
      />
      <View
        style={[
          styles.checkLong,
          {
            top: 24 * s,
            left: 18 * s,
            width: 3 * s,
            height: 14 * s,
            borderRadius: 1.5 * s,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "relative" },
  document: { position: "absolute", backgroundColor: LOGO_INK },
  fold: {
    position: "absolute",
    width: 0,
    height: 0,
    borderBottomColor: "transparent",
    borderLeftColor: "#3A4A52",
  },
  hook: { position: "absolute", backgroundColor: LOGO_INK },
  checkShort: {
    position: "absolute",
    backgroundColor: LOGO_CHECK,
    transform: [{ rotate: "-45deg" }],
  },
  checkLong: {
    position: "absolute",
    backgroundColor: LOGO_CHECK,
    transform: [{ rotate: "45deg" }],
  },
});
