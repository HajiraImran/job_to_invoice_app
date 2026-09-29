import { colors } from "../theme.ts";
import { copy } from "../i18n/en.ts";

export const WELCOME_HREF = "/(public)/welcome";
export const WELCOME_SIGN_IN_HREF = "/(public)/sign-in";

/** Approved S01 tokens that differ from the global 16 pt gutter / 12 pt radius / 48 pt button. */
export const WELCOME_PRIMARY_ACTION = colors.navy;
export const WELCOME_PRIMARY_BUTTON_MIN_HEIGHT = 56;
export const WELCOME_GUTTER = 24;
export const WELCOME_CARD_RADIUS = 18;
export const WELCOME_HIT_TARGET = 44;

export const WELCOME_SAMPLE_TOTAL_CENTS = 104000;
export const WELCOME_SAMPLE_LINE_CENTS = [64000, 22000, 18000] as const;

export type WelcomeSampleLine = {
  description: string;
  quantityLabel: string;
  amountCents: number;
  amountLabel: string;
};

export type WelcomeSampleDocument = {
  status: string;
  title: string;
  subtitle: string;
  customerName: string;
  quoteDate: string;
  lines: WelcomeSampleLine[];
  totalCents: number;
  totalLabel: string;
  totalAmountLabel: string;
  cannotSendLabel: string;
  sendAvailable: false;
  paywallVisible: false;
  decorative: true;
  includedInAnalytics: false;
};

export type WelcomeLayoutSpec = {
  primaryActionColor: typeof WELCOME_PRIMARY_ACTION;
  primaryButtonMinHeight: typeof WELCOME_PRIMARY_BUTTON_MIN_HEIGHT;
  gutter: typeof WELCOME_GUTTER;
  cardRadius: typeof WELCOME_CARD_RADIUS;
  termsAreLinks: false;
  developmentControlVisible: false;
  settingsVisible: false;
  sampleDecorative: true;
  sampleIncludedInAnalytics: false;
};

export type WelcomePrimaryActions = {
  createFirstQuote: string;
  signIn: string;
  createHref: typeof WELCOME_SIGN_IN_HREF;
  signInHref: typeof WELCOME_SIGN_IN_HREF;
};

export type WelcomeScreenPresentation = {
  heading: string;
  supportingText: string;
  logoLabel: string;
  primaryAction: string;
  primaryLabel: string;
  secondaryAction: string;
  secondaryLabel: string;
  footer: string;
  createHref: typeof WELCOME_SIGN_IN_HREF;
  signInHref: typeof WELCOME_SIGN_IN_HREF;
  accessibleOrder: readonly string[];
};

/** Integer-cents USD with thousands grouping for the approved S01 total. */
export function formatWelcomeUsdCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error("USD amounts must be non-negative integer cents");
  }
  const dollars = Math.trunc(cents / 100);
  const frac = cents % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${frac.toString().padStart(2, "0")}`;
}

export function presentWelcomeSample(): WelcomeSampleDocument {
  const descriptions = [
    copy.welcomeSampleLineDecking,
    copy.welcomeSampleLineHardware,
    copy.welcomeSampleLineCleanup,
  ] as const;
  const lines = WELCOME_SAMPLE_LINE_CENTS.map((amountCents, index) => ({
    description: descriptions[index] ?? "",
    quantityLabel: copy.welcomeSampleQty,
    amountCents,
    amountLabel: formatWelcomeUsdCents(amountCents),
  }));
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    status: copy.welcomeSampleStatus,
    title: copy.welcomeSampleTitle,
    subtitle: copy.welcomeSampleSubtitle,
    customerName: copy.welcomeSampleCustomer,
    quoteDate: copy.welcomeSampleDate,
    lines,
    totalCents,
    totalLabel: copy.welcomeSampleTotalPrefix,
    totalAmountLabel: formatWelcomeUsdCents(totalCents),
    cannotSendLabel: copy.welcomeSampleCannotSend,
    sendAvailable: false,
    paywallVisible: false,
    decorative: true,
    includedInAnalytics: false,
  };
}

export function welcomePrimaryActions(): WelcomePrimaryActions {
  return {
    createFirstQuote: copy.createFirstQuote,
    signIn: copy.signIn,
    createHref: WELCOME_SIGN_IN_HREF,
    signInHref: WELCOME_SIGN_IN_HREF,
  };
}

export function welcomeLayoutSpec(): WelcomeLayoutSpec {
  return {
    primaryActionColor: WELCOME_PRIMARY_ACTION,
    primaryButtonMinHeight: WELCOME_PRIMARY_BUTTON_MIN_HEIGHT,
    gutter: WELCOME_GUTTER,
    cardRadius: WELCOME_CARD_RADIUS,
    termsAreLinks: false,
    developmentControlVisible: false,
    settingsVisible: false,
    sampleDecorative: true,
    sampleIncludedInAnalytics: false,
  };
}

export function presentWelcomeScreen(): WelcomeScreenPresentation {
  const actions = welcomePrimaryActions();
  const accessibleOrder = [
    copy.welcomeLogoLabel,
    copy.appName,
    copy.welcomePromise,
    copy.welcomeCreateLabel,
    copy.welcomeSignInLabel,
    copy.terms,
  ] as const;
  return {
    heading: copy.appName,
    supportingText: copy.welcomePromise,
    logoLabel: copy.welcomeLogoLabel,
    primaryAction: actions.createFirstQuote,
    primaryLabel: copy.welcomeCreateLabel,
    secondaryAction: actions.signIn,
    secondaryLabel: copy.welcomeSignInLabel,
    footer: copy.terms,
    createHref: actions.createHref,
    signInHref: actions.signInHref,
    accessibleOrder,
  };
}
