import { StyleSheet, View } from "react-native";
import { colors } from "../theme.ts";

type AuthLockMarkProps = {
  size?: number;
};

/** Decorative lock mark for S02. Hidden from assistive technology by the parent. */
export function AuthLockMark({ size = 88 }: AuthLockMarkProps) {
  const shackle = Math.round(size * 0.42);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.badge, { width: size + 36, height: size + 36, borderRadius: (size + 36) / 2 }]}
    >
      <View style={[styles.shackle, { width: shackle, height: Math.round(shackle * 0.72), borderRadius: shackle / 2 }]} />
      <View style={[styles.body, { width: Math.round(size * 0.52), height: Math.round(size * 0.42), borderRadius: 10 }]}>
        <View style={styles.keyhole} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
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
  shackle: {
    borderWidth: 5,
    borderColor: colors.navy,
    borderBottomWidth: 0,
    marginBottom: -4,
    backgroundColor: "transparent",
  },
  body: {
    backgroundColor: colors.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  keyhole: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
});
