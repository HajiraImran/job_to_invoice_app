import { formatUsdCents } from "@job-to-invoice/schemas";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { copy } from "../i18n/en.ts";
import { useAuth } from "../session/AuthProvider.tsx";
import { colors, space, type } from "../theme.ts";
import { type CatalogueItemRecord } from "./form.ts";
import { activePickerItems, itemPickerPath } from "./presentation.ts";

export function CatalogueItemPicker({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (item: CatalogueItemRecord) => void;
}) {
  const auth = useAuth();
  const runOwnerRequest = auth.runOwnerRequest;
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<CatalogueItemRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    if (auth.snapshot.status !== "authenticated") {
      setError(auth.snapshot.status === "access_expired" ? copy.accessExpired : copy.itemsOffline);
      setItems([]);
      return;
    }
    setLoading(true);
    setError(undefined);
    const result = await runOwnerRequest<{ items: CatalogueItemRecord[] }>({
      path: itemPickerPath(search),
    });
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      setItems([]);
      return;
    }
    setItems(activePickerItems(result.data.items));
  }, [auth.snapshot.status, runOwnerRequest, search]);

  useEffect(() => {
    if (visible) {
      void load();
    }
  }, [visible, load]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{copy.itemsPickerTitle}</Text>
          <Text style={styles.hint}>{copy.itemsSeedHint}</Text>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={copy.itemsSearch}
            accessibilityLabel={copy.itemsSearch}
            style={styles.search}
          />
          {loading ? <ActivityIndicator color={colors.navy} /> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={item.description}
                onPress={() => {
                  onPick(item);
                  onClose();
                }}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>{item.description}</Text>
                <Text style={styles.cardMeta}>
                  {formatUsdCents(item.unit_price_cents)} · {item.default_quantity} {item.unit}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.secondary}>
            <Text style={styles.secondaryLabel}>{copy.itemsPickerClose}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(23,50,77,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.background,
    padding: space.gutter,
    gap: space.scale,
    maxHeight: "85%",
    borderTopLeftRadius: space.radius,
    borderTopRightRadius: space.radius,
  },
  title: { color: colors.text, fontSize: type.section, fontWeight: "700" },
  hint: { color: colors.secondary, fontSize: type.secondary },
  error: { color: colors.danger, fontSize: type.secondary },
  search: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: "#FFFFFF",
  },
  list: { maxHeight: 320 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    padding: space.gutter,
    backgroundColor: "#FFFFFF",
    marginBottom: space.scale,
    minHeight: 44,
  },
  cardTitle: { color: colors.text, fontSize: type.body, fontWeight: "600" },
  cardMeta: { color: colors.secondary, fontSize: type.secondary },
  secondary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.navy,
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
});

