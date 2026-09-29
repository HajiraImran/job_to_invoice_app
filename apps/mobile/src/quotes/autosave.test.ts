import { describe, expect, it } from "vitest";
import { liveTotals, type QuoteFormValues } from "./form.ts";
import {
  decideQuoteAutosave,
  decideQuoteDraftOpen,
  emitQuotePersistDiagnostic,
  persistResultIsCurrent,
  quoteFormFingerprint,
  quoteFormIsUserEdited,
  quotePersistDiagnosticIsSafe,
} from "./autosave.ts";

const emptyForm: QuoteFormValues = { notes: "", terms: "", expiry_days: "14", lines: [] };

const oneItem: QuoteFormValues = {
  notes: "",
  terms: "",
  expiry_days: "14",
  lines: [
    {
      client_line_id: "11111111-1111-4111-8111-111111111111",
      description: "Handle",
      unit: "item",
      custom_unit_label: "",
      quantity: "1",
      unit_price: "100",
      discount: "0",
      tax_percent: "0",
    },
  ],
};

describe("quote editor autosave", () => {
  it("does not save an untouched empty draft", () => {
    const fingerprint = quoteFormFingerprint(emptyForm);
    expect(quoteFormIsUserEdited(fingerprint, fingerprint)).toBe(false);
    expect(liveTotals(emptyForm).ok).toBe(true);
    expect(
      decideQuoteAutosave({
        hasDraft: true,
        userEdited: false,
        saveStatus: "idle",
        totalsOk: true,
        inFlight: false,
      }),
    ).toBe("skip");
  });

  it("schedules save after the owner adds an item", () => {
    const saved = quoteFormFingerprint(emptyForm);
    const current = quoteFormFingerprint(oneItem);
    expect(quoteFormIsUserEdited(current, saved)).toBe(true);
    expect(liveTotals(oneItem).ok).toBe(true);
    expect(
      decideQuoteAutosave({
        hasDraft: true,
        userEdited: true,
        saveStatus: "idle",
        totalsOk: true,
        inFlight: false,
      }),
    ).toBe("schedule");
  });

  it("holds a local write failure until an explicit retry", () => {
    expect(
      decideQuoteAutosave({
        hasDraft: true,
        userEdited: true,
        saveStatus: "storage_failure",
        totalsOk: true,
        inFlight: false,
      }),
    ).toBe("skip");
    expect(
      decideQuoteAutosave({
        hasDraft: true,
        userEdited: true,
        saveStatus: "saving_locally",
        totalsOk: true,
        inFlight: true,
      }),
    ).toBe("skip");
  });

  it("ignores a pending save after the job or generation changes", () => {
    expect(
      persistResultIsCurrent({
        startedGeneration: 1,
        currentGeneration: 2,
        draftJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        screenJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toBe(false);
    expect(
      persistResultIsCurrent({
        startedGeneration: 2,
        currentGeneration: 2,
        draftJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        screenJobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toBe(false);
    expect(
      persistResultIsCurrent({
        startedGeneration: 2,
        currentGeneration: 2,
        draftJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        screenJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toBe(true);
  });

  it("opens a quote draft once per navigation", () => {
    const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      decideQuoteDraftOpen({ jobId, openedJobId: undefined, hasVisibleDraft: false, forceReload: false }),
    ).toBe("post_open");
    expect(
      decideQuoteDraftOpen({ jobId, openedJobId: jobId, hasVisibleDraft: true, forceReload: false }),
    ).toBe("skip");
    expect(
      decideQuoteDraftOpen({ jobId, openedJobId: jobId, hasVisibleDraft: true, forceReload: true }),
    ).toBe("post_open");
  });

  it("emits only a safe persist stage", () => {
    expect(
      quotePersistDiagnosticIsSafe(
        { stage: "enqueue_outbox", outcome: "storage_failure", code: "SYNC_PAUSED" },
        ["customer@", "eyJ", "-----BEGIN"],
      ),
    ).toBe(true);
    expect(quotePersistDiagnosticIsSafe({ stage: "enqueue_outbox", outcome: "storage_failure", payload: "{}" }, [])).toBe(
      false,
    );
    emitQuotePersistDiagnostic({ stage: "hydrate", outcome: "ok" });
  });
});
