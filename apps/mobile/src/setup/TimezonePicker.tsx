import { formatTimeZoneOption, isValidIanaTimeZone } from "@job-to-invoice/schemas";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../i18n/en.ts";
import { colors, space, type } from "../theme.ts";
import { presentConfirmedTimezone, presentTimezonePickerRows, SETUP_HIT_TARGET, SETUP_PRIMARY_BUTTON_MIN_HEIGHT } from "./presentation.ts";

export function TimezonePicker(props: {
  visible: boolean;
  committed: string;
  device?: string;
  onClose: () => void;
  onConfirm: (timeZone: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [provisional, setProvisional] = useState(props.committed);

  useEffect(() => {
    if (props.visible) {
      setQuery("");
      setProvisional(props.committed);
    }
  }, [props.committed, props.visible]);

  const rows = useMemo(
    () => presentTimezonePickerRows(provisional, query, props.device),
    [provisional, props.device, query],
  );
  const confirmLabel = copy.timezoneUse.replace("{zone}", provisional);
  const canConfirm = isValidIanaTimeZone(provisional);

  return (
    <Modal
      animationType="none"
      onRequestClose={props.onClose}
      transparent
      visible={props.visible}
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.gutter) }]}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              {copy.timezonePickerTitle}
            </Text>
            <Pressable
              accessibilityLabel={copy.timezoneClose}
              accessibilityRole="button"
              onPress={props.onClose}
              style={styles.closeHit}
            >
              <Text style={styles.closeLabel}>{copy.timezoneClose}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>{copy.timezonePickerHint}</Text>
          <TextInput
            accessibilityLabel={copy.timezoneSearch}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder={copy.timezonePickerHint}
            placeholderTextColor={colors.secondary}
            style={styles.search}
            value={query}
          />
          {props.device && isValidIanaTimeZone(props.device) ? (
            <Pressable
              accessibilityHint={copy.timezoneDevice}
              accessibilityLabel={`${copy.timezoneDevice}: ${formatTimeZoneOption(props.device)}`}
              accessibilityRole="button"
              onPress={() => setProvisional(props.device ?? props.committed)}
              style={styles.device}
            >
              <Text style={styles.deviceLabel}>{copy.timezoneDevice}</Text>
              <Text style={styles.deviceValue}>{formatTimeZoneOption(props.device)}</Text>
            </Pressable>
          ) : null}
          <FlatList
            data={rows}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text accessibilityLiveRegion="polite" style={styles.empty}>
                {copy.timezoneEmpty}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: item.selected }}
                onPress={() => setProvisional(item.id)}
                style={[styles.row, item.selected ? styles.rowSelected : null]}
              >
                <Text style={[styles.rowLabel, item.selected ? styles.rowLabelSelected : null]}>{item.label}</Text>
                {item.selected ? <Text style={styles.selectedMark}>✓</Text> : null}
              </Pressable>
            )}
            style={styles.list}
          />
          <Pressable
            accessibilityLabel={confirmLabel}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canConfirm }}
            disabled={!canConfirm}
            onPress={() => {
              props.onConfirm(presentConfirmedTimezone(provisional, props.committed));
            }}
            style={[styles.confirm, canConfirm ? null : styles.confirmDisabled]}
          >
            <Text style={styles.confirmLabel}>{confirmLabel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(23,50,77,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.surface,
    paddingHorizontal: 20,
    paddingTop: space.gutter,
    gap: space.scale,
    maxHeight: "88%",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.scale },
  title: { color: colors.text, fontSize: type.section, fontWeight: "700", flex: 1 },
  closeHit: { minHeight: SETUP_HIT_TARGET, minWidth: SETUP_HIT_TARGET, justifyContent: "center", alignItems: "flex-end" },
  closeLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  hint: { color: colors.secondary, fontSize: type.secondary },
  search: {
    minHeight: SETUP_HIT_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  device: {
    minHeight: SETUP_HIT_TARGET,
    backgroundColor: colors.infoTint,
    borderRadius: space.radius,
    paddingHorizontal: space.gutter,
    paddingVertical: space.scale,
    justifyContent: "center",
  },
  deviceLabel: { color: colors.navy, fontSize: type.secondary, fontWeight: "700" },
  deviceValue: { color: colors.text, fontSize: type.secondary },
  list: { maxHeight: 360 },
  empty: { color: colors.secondary, fontSize: type.secondary, paddingVertical: space.gutter },
  row: {
    minHeight: SETUP_HIT_TARGET,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  rowSelected: { backgroundColor: colors.infoTint },
  rowLabel: { color: colors.text, fontSize: type.body, flex: 1 },
  rowLabelSelected: { color: colors.navy, fontWeight: "600" },
  selectedMark: { color: colors.navy, fontSize: type.body, fontWeight: "700", marginLeft: space.scale },
  confirm: {
    minHeight: SETUP_PRIMARY_BUTTON_MIN_HEIGHT,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmDisabled: { opacity: 0.5 },
  confirmLabel: { color: colors.surface, fontSize: type.body, fontWeight: "600", textAlign: "center" },
});
