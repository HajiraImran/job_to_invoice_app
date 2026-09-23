import { SUPPORT_MESSAGE_MIN, type SupportCategory } from "@job-to-invoice/schemas";
import { useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { retainOrCreateSetupIdempotencyKey } from "../../../src/setup/idempotency.ts";
import { copy } from "../../../src/i18n/en.ts";
import { useAuth } from "../../../src/session/AuthProvider.tsx";
import {
  categoryLabel,
  presentSupport,
  supportCategories,
  type SupportCaseRecord,
} from "../../../src/support/presentation.ts";
import { colors, space, type } from "../../../src/theme.ts";

export default function SupportScreen() {
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const [category, setCategory] = useState<SupportCategory>("account");
  const [message, setMessage] = useState("");
  const [grantContent, setGrantContent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<SupportCaseRecord | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [submitKey] = useState(() => retainOrCreateSetupIdempotencyKey(undefined));
  const supportUrl = auth.bootstrap?.support_url ?? submitted?.support_url ?? null;

  const view = presentSupport({
    authStatus: auth.snapshot.status,
    submitting,
    submitted,
    error,
  });

  async function onSubmit() {
    if (view.submitDisabled) {
      return;
    }
    setSubmitting(true);
    const result = await auth.runOwnerRequest<SupportCaseRecord>({
      path: "/v1/support/cases",
      method: "POST",
      idempotencyKey: submitKey,
      body: {
        category,
        message,
        grant_content_access: grantContent,
      },
    });
    if (result.ok) {
      setSubmitted(result.data);
      setError(undefined);
    } else {
      setError(result.error.message || copy.supportSubmitError);
    }
    setSubmitting(false);
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <Text accessibilityRole="header" style={styles.title}>
        {copy.supportTitle}
      </Text>
      <Text style={styles.body}>{copy.supportIntro}</Text>
      <Text style={styles.body}>{copy.supportNoSla}</Text>
      {supportUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={copy.supportPublicLink}
          onPress={() => void Linking.openURL(supportUrl)}
          style={styles.secondary}
        >
          <Text style={styles.secondaryLabel}>{copy.supportPublicLink}</Text>
        </Pressable>
      ) : null}
      {view.kind === "offline" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.supportOffline}
        </Text>
      ) : null}
      {view.kind === "access_expired" ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.accessExpired}
        </Text>
      ) : null}
      {view.kind === "submitted" && submitted ? (
        <Text accessibilityLiveRegion="polite" style={styles.banner}>
          {copy.supportSubmitted.replace("{category}", categoryLabel(submitted.category as SupportCategory))}
        </Text>
      ) : null}
      {view.message ? (
        <Text accessibilityLiveRegion="assertive" style={styles.banner}>
          {view.message}
        </Text>
      ) : null}
      {view.kind === "submitting" ? <ActivityIndicator color={colors.navy} /> : null}
      {view.kind === "form" || view.kind === "error" ? (
        <>
          <Text style={styles.label}>{copy.supportCategoryLabel}</Text>
          {supportCategories().map((item) => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityState={{ selected: category === item }}
              accessibilityLabel={categoryLabel(item)}
              onPress={() => setCategory(item)}
              style={[styles.choice, category === item ? styles.choiceSelected : null]}
            >
              <Text style={styles.choiceLabel}>{categoryLabel(item)}</Text>
            </Pressable>
          ))}
          <Text style={styles.label}>{copy.supportMessageLabel}</Text>
          <TextInput
            accessibilityLabel={copy.supportMessageLabel}
            multiline
            value={message}
            onChangeText={setMessage}
            placeholder={copy.supportMessagePlaceholder.replace("{min}", String(SUPPORT_MESSAGE_MIN))}
            placeholderTextColor={colors.secondary}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: grantContent }}
            accessibilityLabel={copy.supportGrantLabel}
            onPress={() => setGrantContent((current) => !current)}
            style={[styles.choice, grantContent ? styles.choiceSelected : null]}
          >
            <Text style={styles.choiceLabel}>{copy.supportGrantLabel}</Text>
          </Pressable>
          <Text style={styles.body}>{copy.supportGrantHelp}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.supportSubmit}
            accessibilityState={{ disabled: view.submitDisabled }}
            disabled={view.submitDisabled}
            onPress={() => void onSubmit()}
            style={[styles.button, view.submitDisabled ? styles.disabled : null]}
          >
            <Text style={styles.buttonLabel}>{submitting ? copy.supportSubmitting : copy.supportSubmit}</Text>
          </Pressable>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.background },
  screen: { backgroundColor: colors.background, padding: space.gutter, gap: space.scale },
  title: { color: colors.text, fontSize: type.screen, fontWeight: "700" },
  banner: { color: colors.navy, fontSize: type.secondary },
  body: { color: colors.secondary, fontSize: type.body },
  label: { color: colors.text, fontSize: type.secondary, fontWeight: "600", marginTop: space.scale },
  input: {
    minHeight: 120,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    padding: space.scale,
    color: colors.text,
    fontSize: type.body,
    textAlignVertical: "top",
  },
  choice: {
    minHeight: 44,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  choiceSelected: { backgroundColor: "#e8eef5" },
  choiceLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  secondary: {
    minHeight: 44,
    borderColor: colors.navy,
    borderWidth: 1,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryLabel: { color: colors.navy, fontSize: type.body, fontWeight: "600" },
  button: {
    minHeight: 44,
    backgroundColor: colors.navy,
    borderRadius: space.radius,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.scale,
  },
  buttonLabel: { color: colors.background, fontSize: type.body, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
