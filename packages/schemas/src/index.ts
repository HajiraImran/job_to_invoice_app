/** Snapshot schema versions will be added with QUO02A. Foundation has no commercial snapshot. */
export const SNAPSHOT_SCHEMA_VERSION = 0;

export {
  EMAIL_MAX_LENGTH,
  maskEmail,
  parseOwnerEmail,
  type EmailParseResult,
} from "./email.ts";
export {
  API_ERROR_CODES,
  httpStatusForCode,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiFieldError,
  type ApiSuccessBody,
} from "./envelope.ts";
export { analyticsPropertiesAreSafe, redactRecord, redactText } from "./redact.ts";
export {
  BOOTSTRAP_SUPPORT_CODES,
  EMPTY_DRAFT_SYNC,
  OFFLINE_READ_WINDOW_MS,
  OTP_LENGTH,
  OTP_MAX_FAILURES,
  RESEND_COOLDOWN_MS,
  canResend,
  isOfflineReadPermitted,
  publicRouteAllowed,
  remainingResendSeconds,
  resendAvailableAt,
  routeGroupFor,
  signOutClears,
  type AuthSnapshot,
  type AuthStatus,
  type BootstrapSupportCode,
  type DraftSyncStatus,
  type RouteGroup,
} from "./auth-state.ts";
export {
  ALL_ANALYTICS_EVENTS,
  ANALYTICS_SCHEMA_VERSION,
  CLIENT_EVENTS,
  SERVER_ONLY_EVENTS,
  isClientAnalyticsEvent,
  isServerOnlyAnalyticsEvent,
  type AnalyticsEventName,
} from "./analytics.ts";
export {
  US_STATES,
  ZIP_PATTERN,
  isUsStateCode,
  parseUsAddress,
  type UsAddress,
  type UsStateCode,
} from "./address.ts";
export { parseOptionalPhone } from "./phone.ts";
export { hasDisallowedControl, parseBoundedText, parseOptionalBoundedText } from "./text.ts";
export {
  US_TIMEZONES,
  calendarDateInTimeZone,
  deviceTimeZone,
  isValidIanaTimeZone,
  naiveUtcMidnightCalendarDate,
  wallTimeToUtc,
} from "./timezone.ts";
export {
  DUE_DAYS_MAX,
  DUE_DAYS_MIN,
  FORBIDDEN_SETUP_FIELDS,
  TAX_BP_MAX,
  TAX_BP_MIN,
  TERMS_MAX,
  WORKSPACE_SETUP_FIELDS,
  parseDueDays,
  parseTaxBp,
  parseTaxPercentToBp,
  parseWorkspaceSetup,
  taxBpToPercentLabel,
  type FieldError,
  type WorkspaceSetupInput,
  type WorkspaceSetupParseResult,
  type WorkspaceTrade,
} from "./workspace-setup.ts";

export {
  MONEY_ERROR_CODES,
  MONEY_SCHEMA_VERSION,
  type ChangeOrderInputV1,
  type ChangeOrderResultV1,
  type CreditAllocationInputV1,
  type CreditResultV1,
  type DocumentTotalsV1,
  type InvoiceCreditLineInputV1,
  type InvoiceTotalsV1,
  type LedgerStateV1,
  type LedgerViewV1,
  type LineInputV1,
  type LineResultV1,
  type MoneyErrorCode,
  type MoneySchemaVersion,
  type PaymentStatusV1,
  type ReductionResultV1,
  type ResidualInvoiceLineInputV1,
  type SourceLineInputV1,
} from "./money.ts";
