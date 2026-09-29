import { StyleSheet, Text, View } from "react-native";
import { colors, space, type } from "../theme.ts";
import { BrandLogo } from "./BrandLogo.tsx";
import {
  WELCOME_CARD_RADIUS,
  type WelcomeSampleDocument,
} from "./presentation.ts";

type WelcomeQuotePreviewProps = {
  sample: WelcomeSampleDocument;
};

export function WelcomeQuotePreview({ sample }: WelcomeQuotePreviewProps) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.stage}
    >
      <View style={styles.depth} />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <BrandLogo decorative size={28} />
          <Text style={styles.status}>{sample.status}</Text>
        </View>
        <Text style={styles.title}>{sample.title}</Text>
        <Text style={styles.subtitle}>{sample.subtitle}</Text>
        <Text style={styles.meta}>
          {sample.customerName}
          {"  ·  "}
          {sample.quoteDate}
        </Text>
        <View style={styles.divider} />
        {sample.lines.map((line) => (
          <View key={line.description} style={styles.lineRow}>
            <Text style={styles.lineDescription}>{line.description}</Text>
            <Text style={styles.lineAmount}>{line.amountLabel}</Text>
          </View>
        ))}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{sample.totalLabel}</Text>
          <Text numberOfLines={1} style={styles.totalAmount}>
            {sample.totalAmountLabel}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    width: "100%",
    maxWidth: 360,
    alignSelf: "center",
    paddingHorizontal: space.scale,
    paddingVertical: space.gutter,
  },
  depth: {
    position: "absolute",
    top: space.gutter + 8,
    right: space.scale + 6,
    bottom: space.gutter - 4,
    left: space.scale + 10,
    backgroundColor: colors.surface,
    borderRadius: WELCOME_CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.5,
    transform: [{ rotate: "-8deg" }],
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: WELCOME_CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.gutter,
    gap: space.scale,
    transform: [{ rotate: "-4deg" }],
    shadowColor: colors.text,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.12,
    shadowRadius: 22,
    elevation: 7,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  status: {
    color: colors.navy,
    fontSize: type.secondary,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  title: { color: colors.text, fontSize: type.body, fontWeight: "700" },
  subtitle: { color: colors.secondary, fontSize: type.secondary, fontWeight: "600" },
  meta: { color: colors.secondary, fontSize: type.secondary },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  lineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.scale,
  },
  lineDescription: {
    flex: 1,
    flexShrink: 1,
    color: colors.text,
    fontSize: type.secondary,
  },
  lineAmount: {
    color: colors.text,
    fontSize: type.secondary,
    fontWeight: "600",
    flexShrink: 0,
  },
  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.scale,
    paddingTop: space.scale,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  totalLabel: { color: colors.text, fontSize: type.body, fontWeight: "600", flexShrink: 1 },
  totalAmount: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: "700",
    flexShrink: 0,
  },
});
