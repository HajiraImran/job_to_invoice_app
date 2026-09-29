import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, space, type } from "../theme.ts";
import { presentCodeCells, sanitizeOwnerCode } from "./presentation.ts";

type VerifyCodeFieldProps = {
  value: string;
  label: string;
  hint: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

export function VerifyCodeField({ value, label, hint, disabled, onChange }: VerifyCodeFieldProps) {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const cells = presentCodeCells(value);
  const focusIndex = Math.min(value.length, cells.length - 1);

  return (
    <Pressable
      accessibilityRole="none"
      onPress={() => inputRef.current?.focus()}
      style={styles.wrap}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.cells}
      >
        {cells.map((digit, index) => {
          const isFocus = focused && !disabled && index === focusIndex;
          return (
            <View key={index} style={[styles.cell, isFocus ? styles.cellFocused : null]}>
              <Text style={styles.digit}>{digit}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={inputRef}
        accessibilityHint={hint}
        accessibilityLabel={label}
        autoComplete="one-time-code"
        caretHidden
        editable={!disabled}
        keyboardType="number-pad"
        maxLength={6}
        onBlur={() => setFocused(false)}
        onChangeText={(next) => onChange(sanitizeOwnerCode(next))}
        onFocus={() => setFocused(true)}
        style={styles.input}
        textContentType="oneTimeCode"
        value={value}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: 56,
    justifyContent: "center",
  },
  cells: {
    flexDirection: "row",
    gap: space.scale,
  },
  cell: {
    flex: 1,
    minHeight: 56,
    borderRadius: space.radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  cellFocused: {
    borderColor: colors.navy,
    borderWidth: 2,
  },
  digit: {
    color: colors.text,
    fontSize: type.section,
    fontWeight: "700",
  },
  input: {
    ...StyleSheet.absoluteFill,
    opacity: 0.02,
    color: "transparent",
  },
});
