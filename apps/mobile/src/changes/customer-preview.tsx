import { formatUsdCents } from "@job-to-invoice/schemas";
import { Pressable, Text, TextInput, View } from "react-native";
import { copy } from "../i18n/en.ts";
import { colors } from "../theme.ts";
import {
  changeRecipientPlan,
  presentChangeCustomerPreview,
  type ChangePreviewSnapshot,
  type ChangePublishNotice,
} from "./presentation.ts";

const PRIMARY = "#464B71";

export function ChangeCustomerPreview(props: {
  snapshot: ChangePreviewSnapshot;
  confirming: boolean;
  busy: boolean;
  publishing: boolean;
  notice?: ChangePublishNotice;
  enteredEmail: string;
  onChangeEmail: (value: string) => void;
  onSaveEmail: () => void;
  onReviewPublish: () => void;
  onConfirmPublish: () => void;
  onCancelConfirm: () => void;
  onBack: () => void;
  onRetry: () => void;
  onCheck: () => void;
}) {
  const preview = presentChangeCustomerPreview(props.snapshot);
  const notice = props.notice;
  const recipient = changeRecipientPlan({
    previewEmail: props.snapshot.customer.email,
    enteredEmail: props.enteredEmail,
  });
  const canSend = recipient.kind === "ready" && !props.busy;
  return (
    <View>
      <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 22, fontWeight: "700" }}>
        {preview.unpublishedLabel}
      </Text>
      <Text style={{ color: colors.secondary }}>{copy.changePreviewCustomer}</Text>
      <Text style={{ color: colors.text, fontWeight: "600" }}>{preview.businessName}</Text>
      <Text style={{ color: colors.secondary }}>{preview.customerName}</Text>
      {preview.reason.trim().length > 0 ? <Text style={{ color: colors.text }}>{preview.reason}</Text> : null}
      {preview.additions.map((line) => (
        <View key={`${line.description}:${line.amountCents}`} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ color: colors.text, flex: 1 }}>
            {line.description} · {line.quantity} {line.unit}
          </Text>
          <Text style={{ color: colors.text }}>{formatUsdCents(line.amountCents)}</Text>
        </View>
      ))}
      {preview.reductions.map((line) => (
        <View key={`${line.description}:${line.amountCents}`} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ color: colors.text, flex: 1 }}>{line.description}</Text>
          <Text style={{ color: colors.text }}>{formatUsdCents(line.amountCents)}</Text>
        </View>
      ))}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: colors.secondary }}>{copy.changePreviousTotal}</Text>
        <Text style={{ color: colors.text }}>{formatUsdCents(preview.previousCents)}</Text>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: colors.secondary }}>{copy.changeDelta}</Text>
        <Text style={{ color: colors.text }}>{formatUsdCents(preview.changeCents)}</Text>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: colors.text, fontWeight: "700" }}>{copy.changeNewTotal}</Text>
        <Text style={{ color: colors.text, fontWeight: "700" }}>{formatUsdCents(preview.revisedCents)}</Text>
      </View>
      <Text style={{ color: colors.secondary }}>{copy.changeRecipientLabel}</Text>
      <TextInput
        value={props.enteredEmail}
        onChangeText={props.onChangeEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        editable={!props.busy}
        style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, color: colors.text }}
      />
      {recipient.kind === "ready" ? (
        <Text style={{ color: colors.text }}>
          {copy.changeRecipientReady} {recipient.email}
        </Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: props.busy }}
          disabled={props.busy}
          onPress={props.onSaveEmail}
          style={{ minHeight: 48, borderRadius: 12, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>{copy.changeRecipientSave}</Text>
        </Pressable>
      )}
      {notice ? (
        <View>
          <Text accessibilityLiveRegion="polite" style={{ color: "#B42318" }}>
            {notice.message}
          </Text>
          {notice.showRetry ? (
            <Pressable accessibilityRole="button" onPress={props.onRetry} style={{ minHeight: 48, justifyContent: "center" }}>
              <Text style={{ color: PRIMARY, fontWeight: "600" }}>{notice.retryLabel}</Text>
            </Pressable>
          ) : null}
          {notice.showCheck ? (
            <Pressable accessibilityRole="button" onPress={props.onCheck} style={{ minHeight: 48, justifyContent: "center" }}>
              <Text style={{ color: PRIMARY, fontWeight: "600" }}>{notice.checkLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {recipient.kind === "ready" && props.confirming ? (
        <View>
          <Text style={{ color: colors.text, fontWeight: "700" }}>{copy.changePublishConfirmTitle}</Text>
          <Text style={{ color: colors.secondary }}>{copy.changePublishConfirmBody}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: props.busy, busy: props.publishing }}
            disabled={!canSend}
            onPress={props.onConfirmPublish}
            style={{ minHeight: 48, borderRadius: 12, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>
              {props.publishing ? copy.changePublishing : copy.changePublishConfirm}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={props.onCancelConfirm} style={{ minHeight: 48, justifyContent: "center" }}>
            <Text style={{ color: PRIMARY, fontWeight: "600" }}>{copy.changePreviewBack}</Text>
          </Pressable>
        </View>
      ) : recipient.kind === "ready" ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: props.busy }}
            disabled={!canSend}
            onPress={props.onReviewPublish}
            style={{ minHeight: 48, borderRadius: 12, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>{copy.changePublish}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={props.onBack} style={{ minHeight: 48, justifyContent: "center" }}>
            <Text style={{ color: PRIMARY, fontWeight: "600" }}>{copy.changePreviewBack}</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable accessibilityRole="button" onPress={props.onBack} style={{ minHeight: 48, justifyContent: "center" }}>
          <Text style={{ color: PRIMARY, fontWeight: "600" }}>{copy.changePreviewBack}</Text>
        </Pressable>
      )}
    </View>
  );
}
