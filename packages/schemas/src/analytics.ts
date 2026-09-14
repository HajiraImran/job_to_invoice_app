export const ANALYTICS_SCHEMA_VERSION = 1;

export const SERVER_ONLY_EVENTS = [
  "signup_verified",
  "document_published",
  "request_delivery_result",
  "approval_completed",
  "invoice_issued",
  "payment_recorded",
  "trial_started",
  "purchase_verified",
  "subscription_expired",
  "export_completed",
] as const;

export const CLIENT_EVENTS = [
  "onboarding_completed",
  "job_created",
  "change_started",
  "paywall_viewed",
  "sync_conflict",
  "support_opened",
] as const;

export const ALL_ANALYTICS_EVENTS = [...SERVER_ONLY_EVENTS, ...CLIENT_EVENTS] as const;

export type AnalyticsEventName = (typeof ALL_ANALYTICS_EVENTS)[number];

const SERVER_ONLY = new Set<string>(SERVER_ONLY_EVENTS);
const CLIENT = new Set<string>(CLIENT_EVENTS);

export function isClientAnalyticsEvent(name: string): name is (typeof CLIENT_EVENTS)[number] {
  return CLIENT.has(name);
}

export function isServerOnlyAnalyticsEvent(name: string): boolean {
  return SERVER_ONLY.has(name);
}
