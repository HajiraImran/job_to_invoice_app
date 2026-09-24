import { formatUsdCents } from "@job-to-invoice/schemas";
import { copy } from "../i18n/en.ts";

export const WELCOME_HREF = "/(public)/welcome";
export const WELCOME_SIGN_IN_HREF = "/(public)/sign-in";

/** Fictional S01 sample. Amounts are integer cents. Cannot be sent. */
export const WELCOME_SAMPLE_LINE_CENTS = 10000;

export type WelcomeSampleLine = {
  description: string;
  quantityLabel: string;
  amountCents: number;
  amountLabel: string;
};

export type WelcomeSampleDocument = {
  title: string;
  businessName: string;
  customerName: string;
  jobTitle: string;
  lines: WelcomeSampleLine[];
  totalCents: number;
  totalLabel: string;
  cannotSendLabel: string;
  sendAvailable: false;
  paywallVisible: false;
};

export function presentWelcomeSample(): WelcomeSampleDocument {
  const amountCents = WELCOME_SAMPLE_LINE_CENTS;
  return {
    title: copy.welcomeSampleTitle,
    businessName: copy.welcomeSampleBusiness,
    customerName: copy.welcomeSampleCustomer,
    jobTitle: copy.welcomeSampleJob,
    lines: [
      {
        description: copy.welcomeSampleLine,
        quantityLabel: copy.welcomeSampleQty,
        amountCents,
        amountLabel: formatUsdCents(amountCents),
      },
    ],
    totalCents: amountCents,
    totalLabel: `${copy.welcomeSampleTotalPrefix} ${formatUsdCents(amountCents)}`,
    cannotSendLabel: copy.welcomeSampleCannotSend,
    sendAvailable: false,
    paywallVisible: false,
  };
}

export function welcomePrimaryActions(): { createFirstQuote: string; signIn: string; href: string } {
  return {
    createFirstQuote: copy.createFirstQuote,
    signIn: copy.signIn,
    href: WELCOME_SIGN_IN_HREF,
  };
}
