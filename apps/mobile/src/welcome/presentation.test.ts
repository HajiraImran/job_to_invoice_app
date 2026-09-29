import { describe, expect, it } from "vitest";
import { copy } from "../i18n/en.ts";
import { colors } from "../theme.ts";
import {
  formatWelcomeUsdCents,
  presentWelcomeSample,
  presentWelcomeScreen,
  welcomeLayoutSpec,
  welcomePrimaryActions,
  WELCOME_CARD_RADIUS,
  WELCOME_GUTTER,
  WELCOME_HIT_TARGET,
  WELCOME_PRIMARY_ACTION,
  WELCOME_PRIMARY_BUTTON_MIN_HEIGHT,
  WELCOME_SAMPLE_LINE_CENTS,
  WELCOME_SAMPLE_TOTAL_CENTS,
  WELCOME_SIGN_IN_HREF,
} from "./presentation.ts";

describe("S01 welcome screen", () => {
  it("presents the approved heading, supporting text, and actions", () => {
    const screen = presentWelcomeScreen();
    expect(screen.heading).toBe("Job to Invoice");
    expect(screen.supportingText).toBe("Create professional quotes and invoices, then get them approved.");
    expect(screen.primaryAction).toBe("Create my first quote");
    expect(screen.secondaryAction).toBe("Sign in");
    expect(screen.footer).toBe("By continuing you agree to the Terms and Privacy Notice.");
  });

  it("routes both actions to the existing S02 owner-email path", () => {
    const actions = welcomePrimaryActions();
    const screen = presentWelcomeScreen();
    expect(actions.createHref).toBe(WELCOME_SIGN_IN_HREF);
    expect(actions.signInHref).toBe(WELCOME_SIGN_IN_HREF);
    expect(screen.createHref).toBe("/(public)/sign-in");
    expect(screen.signInHref).toBe("/(public)/sign-in");
    expect(screen.createHref).toBe(screen.signInHref);
  });

  it("exposes accessibility labels in logical order without sample data", () => {
    const screen = presentWelcomeScreen();
    expect(screen.logoLabel).toBe(copy.welcomeLogoLabel);
    expect(screen.primaryLabel).toBe("Create my first quote");
    expect(screen.secondaryLabel).toBe("Sign in");
    expect(screen.accessibleOrder).toEqual([
      copy.welcomeLogoLabel,
      "Job to Invoice",
      copy.welcomePromise,
      "Create my first quote",
      "Sign in",
      copy.terms,
    ]);
    expect(screen.accessibleOrder.join(" ")).not.toContain("Alex Rivera");
    expect(screen.accessibleOrder.join(" ")).not.toContain("$1,040.00");
  });

  it("presents a fictional three-line sample that cannot be sent or analyzed", () => {
    const sample = presentWelcomeSample();
    expect(sample.title).toBe("Sample Quote");
    expect(sample.subtitle).toBe("Northside Porch Repair");
    expect(sample.status).toBe("QUOTE");
    expect(sample.customerName).toBe("Alex Rivera");
    expect(sample.quoteDate).toBe("Sep 15, 2026");
    expect(sample.lines).toHaveLength(3);
    expect(sample.lines.map((line) => line.description)).toEqual([
      "Porch decking repair",
      "Rail hardware",
      "Site cleanup",
    ]);
    expect(sample.lines.map((line) => line.amountCents)).toEqual([...WELCOME_SAMPLE_LINE_CENTS]);
    expect(sample.totalCents).toBe(WELCOME_SAMPLE_TOTAL_CENTS);
    expect(sample.totalAmountLabel).toBe("$1,040.00");
    expect(sample.sendAvailable).toBe(false);
    expect(sample.paywallVisible).toBe(false);
    expect(sample.decorative).toBe(true);
    expect(sample.includedInAnalytics).toBe(false);
    expect(sample.cannotSendLabel).toBe(copy.welcomeSampleCannotSend);
  });

  it("locks the approved S01 visual contract and omits public Settings", () => {
    const layout = welcomeLayoutSpec();
    expect(layout.primaryActionColor).toBe(WELCOME_PRIMARY_ACTION);
    expect(layout.primaryActionColor).toBe(colors.navy);
    expect(layout.primaryActionColor).toBe("#17324D");
    expect(layout.primaryButtonMinHeight).toBe(56);
    expect(layout.primaryButtonMinHeight).toBe(WELCOME_PRIMARY_BUTTON_MIN_HEIGHT);
    expect(layout.primaryButtonMinHeight).toBeGreaterThanOrEqual(48);
    expect(layout.gutter).toBe(WELCOME_GUTTER);
    expect(layout.cardRadius).toBe(WELCOME_CARD_RADIUS);
    expect(WELCOME_HIT_TARGET).toBe(44);
    expect(layout.termsAreLinks).toBe(false);
    expect(layout.developmentControlVisible).toBe(false);
    expect(layout.settingsVisible).toBe(false);
    expect(layout.sampleDecorative).toBe(true);
    expect(layout.sampleIncludedInAnalytics).toBe(false);
  });

  it("formats the sample total from integer cents", () => {
    expect(formatWelcomeUsdCents(104000)).toBe("$1,040.00");
    expect(formatWelcomeUsdCents(64000)).toBe("$640.00");
    expect(() => formatWelcomeUsdCents(10.4)).toThrow(/integer cents/);
  });
});
