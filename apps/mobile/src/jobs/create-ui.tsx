import { Pressable, StyleSheet, Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { copy } from "../i18n/en.ts";
import { colors, type } from "../theme.ts";
import {
  CREATE_JOB_BACK_VISUAL,
  CREATE_JOB_BADGE_FILL,
  CREATE_JOB_CARD_RADIUS,
  CREATE_JOB_HEADING_LINE,
  CREATE_JOB_HEADING_SIZE,
  CREATE_JOB_HINT_SIZE,
  CREATE_JOB_HIT,
  CREATE_JOB_LABEL_SIZE,
  CREATE_JOB_PRIMARY_ACTION,
  CREATE_JOB_PRIMARY_MIN_HEIGHT,
  CREATE_JOB_PRIMARY_PRESSED,
  CREATE_JOB_SECTION_SIZE,
} from "./create-presentation.ts";
import type { JobFormValues } from "./form.ts";

export function CreateJobBackButton(props: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={copy.back}
      accessibilityRole="button"
      hitSlop={8}
      onPress={props.onPress}
      style={styles.backHit}
    >
      <View style={styles.backCircle}>
        <View style={styles.backChevron}>
          <View style={styles.backChevronTop} />
          <View style={styles.backChevronBottom} />
        </View>
      </View>
    </Pressable>
  );
}

export function CreateJobHeading(props: { title: string; support: string; onBack: () => void }) {
  return (
    <View style={styles.headingBlock}>
      <View style={styles.titleRow}>
        <CreateJobBackButton onPress={props.onBack} />
        <Text accessibilityRole="header" style={styles.heading}>
          {props.title}
        </Text>
      </View>
      <Text style={styles.support}>{props.support}</Text>
    </View>
  );
}

export function CreateJobModeCard(props: {
  title: string;
  hint: string;
  badge?: string;
  icon: "quote" | "invoice";
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint={props.hint}
      accessibilityLabel={`${props.title}${props.badge ? `, ${props.badge}` : ""}`}
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[styles.modeCard, props.selected ? styles.modeCardSelected : null]}
    >
      <ModeIcon kind={props.icon} />
      <View style={styles.modeCopy}>
        <View style={styles.modeTitleRow}>
          <Text style={styles.modeTitle}>{props.title}</Text>
          {props.badge ? (
            <View style={styles.badge}>
              <Text style={styles.badgeLabel}>{props.badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.modeHint}>{props.hint}</Text>
      </View>
      <RadioMark selected={props.selected} />
    </Pressable>
  );
}

export function CreateJobAddCustomer(props: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={copy.addNewCustomer}
      accessibilityRole="button"
      onPress={props.onPress}
      style={styles.addCustomer}
    >
      <Text style={styles.addPlus}>+</Text>
      <Text style={styles.addCustomerLabel}>{copy.addNewCustomer}</Text>
    </Pressable>
  );
}

export function CreateJobSelectField(props: {
  label: string;
  value: string;
  placeholder: string;
  accessibilityHint?: string;
  error?: string;
  leading?: "person" | "pin";
  onPress: () => void;
}) {
  const filled = Boolean(props.value);
  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.label}>{props.label}</Text>
      <Pressable
        accessibilityHint={props.accessibilityHint}
        accessibilityLabel={`${props.label}, ${props.value || props.placeholder}`}
        accessibilityRole="button"
        onPress={props.onPress}
        style={[styles.selectField, props.error ? styles.fieldError : null]}
      >
        {props.leading === "pin" ? <PinMark /> : <PersonMark />}
        <Text style={filled ? styles.selectValue : styles.selectPlaceholder} numberOfLines={1}>
          {props.value || props.placeholder}
        </Text>
        <ChevronMark />
      </Pressable>
      {props.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

export function CreateJobTextField(props: {
  name: string;
  label: string;
  value: string;
  onChange: <K extends keyof JobFormValues>(key: K, value: JobFormValues[K]) => void;
  register: { current: Record<string, TextInput | null> };
  error?: string;
  required?: boolean;
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
  autoCapitalize?: TextInput["props"]["autoCapitalize"];
  keyboardType?: TextInput["props"]["keyboardType"];
  textContentType?: TextInput["props"]["textContentType"];
}) {
  const labelId = `${props.name}-label`;
  return (
    <View style={styles.fieldBlock}>
      <Text nativeID={labelId} style={styles.label}>
        {props.label}
      </Text>
      <TextInput
        accessibilityHint={props.error ?? props.hint}
        accessibilityLabel={`${props.label}${props.required ? `, ${copy.jobRequired}` : `, ${copy.setupOptional}`}`}
        accessibilityLabelledBy={labelId}
        autoCapitalize={props.autoCapitalize}
        keyboardType={props.keyboardType}
        multiline={props.multiline}
        nativeID={props.name}
        onChangeText={(text) => props.onChange(props.name as keyof JobFormValues, text)}
        placeholder={props.placeholder}
        placeholderTextColor={colors.secondary}
        ref={(node) => {
          props.register.current[props.name] = node;
        }}
        style={[styles.input, props.multiline ? styles.multiline : null, props.error ? styles.fieldError : null]}
        textContentType={props.textContentType}
        value={props.value}
      />
      {props.hint && !props.error ? <Text style={styles.hint}>{props.hint}</Text> : null}
      {props.error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

export function CreateJobSiteChoice(props: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[styles.siteChoice, props.selected ? styles.siteChoiceSelected : null]}
    >
      <Text style={[styles.siteChoiceLabel, props.selected ? styles.siteChoiceLabelSelected : null]}>{props.label}</Text>
      <RadioMark selected={props.selected} />
    </Pressable>
  );
}

export function CreateJobPrimaryButton(props: {
  label: string;
  disabled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={(state: PressableStateCallbackType) => [
        styles.primary,
        props.disabled ? styles.primaryDisabled : null,
        state.pressed && !props.disabled ? styles.primaryPressed : null,
      ]}
    >
      <Text style={styles.primaryLabel}>{props.label}</Text>
    </Pressable>
  );
}

function RadioMark(props: { selected: boolean }) {
  return (
    <View style={[styles.radio, props.selected ? styles.radioSelected : null]}>
      {props.selected ? <View style={styles.radioDot} /> : null}
    </View>
  );
}

function ModeIcon(props: { kind: "quote" | "invoice" }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.modeIcon}>
      <View style={styles.docPage}>
        <View style={styles.docLine} />
        <View style={[styles.docLine, props.kind === "invoice" ? styles.docLineMid : styles.docLineShort]} />
        <View style={[styles.docLine, styles.docLineShort]} />
      </View>
    </View>
  );
}

function PersonMark() {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.iconSlot}>
      <View style={styles.personHead} />
      <View style={styles.personShoulders} />
    </View>
  );
}

function PinMark() {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.iconSlot}>
      <View style={styles.pinOuter}>
        <View style={styles.pinInner} />
      </View>
    </View>
  );
}

function ChevronMark() {
  return (
    <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.chevron}>
      ›
    </Text>
  );
}

const styles = StyleSheet.create({
  backHit: {
    minHeight: CREATE_JOB_HIT,
    minWidth: CREATE_JOB_HIT,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  backCircle: {
    width: CREATE_JOB_BACK_VISUAL,
    height: CREATE_JOB_BACK_VISUAL,
    borderRadius: CREATE_JOB_BACK_VISUAL / 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  backChevron: {
    width: 10,
    height: 16,
    marginLeft: -2,
  },
  backChevronTop: {
    position: "absolute",
    top: 2,
    width: 10,
    height: 2,
    backgroundColor: colors.navy,
    transform: [{ rotate: "-45deg" }],
    borderRadius: 1,
  },
  backChevronBottom: {
    position: "absolute",
    bottom: 2,
    width: 10,
    height: 2,
    backgroundColor: colors.navy,
    transform: [{ rotate: "45deg" }],
    borderRadius: 1,
  },
  headingBlock: { gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: CREATE_JOB_HIT },
  heading: {
    color: colors.text,
    fontSize: CREATE_JOB_HEADING_SIZE,
    lineHeight: CREATE_JOB_HEADING_LINE,
    fontWeight: "700",
    letterSpacing: -0.4,
    flex: 1,
  },
  support: {
    color: colors.secondary,
    fontSize: CREATE_JOB_LABEL_SIZE,
    lineHeight: 22,
  },
  modeCard: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: "#E3E8EE",
    borderRadius: 18,
    backgroundColor: colors.surface,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  modeCardSelected: {
    borderColor: CREATE_JOB_PRIMARY_ACTION,
    borderWidth: 1.5,
    backgroundColor: "#F3F6FA",
  },
  modeCopy: { flex: 1, gap: 4 },
  modeTitleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  modeTitle: { color: colors.text, fontSize: type.body, fontWeight: "700" },
  modeHint: { color: colors.secondary, fontSize: CREATE_JOB_HINT_SIZE, lineHeight: 20 },
  badge: {
    backgroundColor: CREATE_JOB_BADGE_FILL,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    minHeight: 22,
    justifyContent: "center",
  },
  badgeLabel: { color: colors.success, fontSize: 12, fontWeight: "700" },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: "#C9D1DA",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  radioSelected: { borderColor: CREATE_JOB_PRIMARY_ACTION, borderWidth: 2 },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: CREATE_JOB_PRIMARY_ACTION },
  fieldBlock: { gap: 8 },
  label: { color: colors.text, fontSize: CREATE_JOB_LABEL_SIZE, fontWeight: "600" },
  hint: { color: colors.secondary, fontSize: CREATE_JOB_HINT_SIZE, lineHeight: 20 },
  error: { color: colors.danger, fontSize: CREATE_JOB_HINT_SIZE },
  selectField: {
    minHeight: CREATE_JOB_PRIMARY_MIN_HEIGHT,
    borderWidth: 1,
    borderColor: "#E3E8EE",
    borderRadius: CREATE_JOB_CARD_RADIUS,
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  selectValue: { flex: 1, color: colors.text, fontSize: type.body },
  selectPlaceholder: { flex: 1, color: colors.secondary, fontSize: type.body },
  fieldError: { borderColor: colors.danger, borderWidth: 2 },
  input: {
    minHeight: CREATE_JOB_PRIMARY_MIN_HEIGHT,
    borderWidth: 1,
    borderColor: "#E3E8EE",
    borderRadius: CREATE_JOB_CARD_RADIUS,
    paddingHorizontal: 16,
    fontSize: type.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  multiline: { minHeight: 96, textAlignVertical: "top", paddingVertical: 14 },
  siteChoice: {
    minHeight: CREATE_JOB_HIT,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: CREATE_JOB_CARD_RADIUS,
    paddingHorizontal: 16,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  siteChoiceSelected: {
    borderColor: CREATE_JOB_PRIMARY_ACTION,
    borderWidth: 1.5,
    backgroundColor: "#F3F6FA",
  },
  siteChoiceLabel: { color: colors.text, fontSize: type.body, fontWeight: "600", flex: 1 },
  siteChoiceLabelSelected: { color: CREATE_JOB_PRIMARY_ACTION },
  addCustomer: {
    minHeight: CREATE_JOB_HIT,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingRight: 8,
  },
  addPlus: { color: CREATE_JOB_PRIMARY_ACTION, fontSize: 20, fontWeight: "600", lineHeight: 22 },
  addCustomerLabel: { color: CREATE_JOB_PRIMARY_ACTION, fontSize: type.body, fontWeight: "600" },
  primary: {
    minHeight: CREATE_JOB_PRIMARY_MIN_HEIGHT,
    backgroundColor: CREATE_JOB_PRIMARY_ACTION,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  primaryDisabled: { opacity: 0.4 },
  primaryPressed: { backgroundColor: CREATE_JOB_PRIMARY_PRESSED },
  primaryLabel: { color: colors.surface, fontSize: type.body, fontWeight: "600", textAlign: "center" },
  modeIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#F3F5F8",
    alignItems: "center",
    justifyContent: "center",
  },
  docPage: {
    width: 16,
    height: 18,
    borderWidth: 1.5,
    borderColor: "#5C6570",
    borderRadius: 2,
    paddingTop: 4,
    paddingHorizontal: 2,
    gap: 2,
  },
  docLine: { height: 1.5, borderRadius: 1, backgroundColor: "#5C6570", width: "100%" },
  docLineShort: { width: "70%" },
  docLineMid: { width: "85%" },
  iconSlot: { width: 22, height: 22, alignItems: "center", justifyContent: "flex-end" },
  personHead: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.navy,
    marginBottom: 2,
  },
  personShoulders: {
    width: 16,
    height: 8,
    borderWidth: 1.5,
    borderColor: colors.navy,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomWidth: 0,
  },
  pinOuter: {
    width: 14,
    height: 18,
    borderWidth: 1.5,
    borderColor: colors.navy,
    borderRadius: 7,
    alignItems: "center",
    paddingTop: 3,
  },
  pinInner: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.navy,
  },
  chevron: { color: "#8A94A6", fontSize: 22, lineHeight: 24, fontWeight: "400", marginTop: -2 },
});

export const createJobSectionStyle = {
  color: colors.text,
  fontSize: CREATE_JOB_SECTION_SIZE,
  fontWeight: "700" as const,
  marginBottom: 4,
};

export const createJobNoticeStyle = {
  color: colors.navy,
  fontSize: CREATE_JOB_LABEL_SIZE,
  lineHeight: 22,
};

export const createJobErrorStyle = {
  color: colors.danger,
  fontSize: CREATE_JOB_HINT_SIZE,
};
