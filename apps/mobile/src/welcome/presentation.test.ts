import { describe, expect, it } from "vitest";
import { copy } from "../i18n/en.ts";
import {
  presentWelcomeSample,
  welcomePrimaryActions,
  WELCOME_SAMPLE_LINE_CENTS,
  WELCOME_SIGN_IN_HREF,
} from "./presentation.ts";

describe("S01 welcome sample document", () => {
  it("presents a fictional quote card that cannot be sent and has no paywall", () => {
    const sample = presentWelcomeSample();
    expect(sample.title).toBe("Sample quote");
    expect(sample.businessName).toBe("Example Handyman");
    expect(sample.customerName).toBe("Alex Rivera");
    expect(sample.jobTitle).toBe("Northside porch repair");
    expect(sample.lines).toHaveLength(1);
    expect(sample.lines[0]?.amountCents).toBe(WELCOME_SAMPLE_LINE_CENTS);
    expect(sample.lines[0]?.amountLabel).toBe("$100.00");
    expect(sample.totalCents).toBe(10000);
    expect(sample.totalLabel).toBe("Total $100.00");
    expect(sample.cannotSendLabel).toBe(copy.welcomeSampleCannotSend);
    expect(sample.sendAvailable).toBe(false);
    expect(sample.paywallVisible).toBe(false);
  });

  it("routes both primary actions to sign-in and does not expose a send control", () => {
    const actions = welcomePrimaryActions();
    expect(actions.createFirstQuote).toBe("Create my first quote");
    expect(actions.signIn).toBe("Sign in");
    expect(actions.href).toBe(WELCOME_SIGN_IN_HREF);
    expect(presentWelcomeSample().sendAvailable).toBe(false);
  });
});
