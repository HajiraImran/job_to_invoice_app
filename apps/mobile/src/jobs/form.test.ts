import { describe, expect, it } from "vitest";
import { jobFormFocusName, jobRequestFromForm, emptyJobForm, listStateFromFilter } from "./form.ts";
import { analyticsPropertiesAreSafe } from "@job-to-invoice/schemas";
import {
  jobLifecycleActions,
  jobPermitsAction,
  nextActionCopy,
  normalizePermittedActions,
  presentCurrentStep,
  presentJobActivity,
  presentJobDetail,
  presentJobDocuments,
  presentJobsList,
  presentModePill,
  presentReceivableCents,
  presentScopeTotalCents,
  presentUpdatedLabel,
  type JobDetail,
} from "./presentation.ts";
import { canOpenCreateJob, createJobDisabled, createJobPath, createLinkedJobPath, jobChangePath, jobDetailPath, jobPublishPath, jobQuotePath, jobReducePath, jobsIndexPath } from "./routes.ts";

describe("job form", () => {
  it("maps a complete form to a create payload", () => {
    const parsed = jobRequestFromForm(
      {
        ...emptyJobForm(),
        customer_name: "Riley Chen",
        title: "Kitchen faucet",
        no_site: false,
        line1: "123 Main Street",
        city: "Austin",
        state: "TX",
        postal_code: "78701",
        mode: "quote",
      },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(parsed.ok).toBe(true);
  });

  it("requires title, customer, mode, and explicit no-site", () => {
    const missing = jobRequestFromForm(emptyJobForm(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(missing.ok).toBe(false);
    const remote = jobRequestFromForm(
      { ...emptyJobForm(), customer_name: "Riley", title: "Remote", no_site: true, mode: "direct_invoice" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(remote.ok).toBe(true);
    if (remote.ok) {
      expect(remote.value.site_address).toBeNull();
      expect(remote.value.mode).toBe("direct_invoice");
    }
    const linked = jobRequestFromForm(
      { ...emptyJobForm(), customer_name: "Riley", title: "Follow-up", no_site: true, mode: "quote" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(linked.value.related_job_id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    }
  });

  it("sends a saved customer id online and a name offline", () => {
    const saved = jobRequestFromForm(
      { ...emptyJobForm(), customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Faucet", no_site: true, mode: "quote" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      undefined,
      { savedCustomer: true },
    );
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.value.customer_id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      expect(saved.value.customer_name).toBeNull();
    }
    const offline = jobRequestFromForm(
      { ...emptyJobForm(), customer_name: "Riley", title: "Faucet", no_site: true, mode: "quote" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(offline.ok).toBe(true);
    if (offline.ok) {
      expect(offline.value.customer_id).toBeNull();
      expect(offline.value.customer_name).toBe("Riley");
    }
  });

  it("focuses the first invalid site field", () => {
    expect(jobFormFocusName("site_address.line1")).toBe("line1");
    expect(jobFormFocusName("site_address")).toBe("line1");
    expect(listStateFromFilter("active")).toBe("open");
    expect(listStateFromFilter("archived")).toBe("archived");
  });
});

describe("jobs list and detail states", () => {
  const job = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    customer_name: "Riley",
    title: "Faucet",
    lifecycle: "draft",
    mode: "quote",
    no_site: true,
    version: 1,
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:00:00.000Z",
  };

  it("shows loading, empty, error, and success without shifting create", () => {
    expect(
      presentJobsList({ authStatus: "authenticated", loading: true, loadedOnce: false, items: [], searching: false }).kind,
    ).toBe("loading");
    expect(
      presentJobsList({
        authStatus: "authenticated",
        loading: false,
        loadedOnce: true,
        items: [],
        searching: false,
      }).kind,
    ).toBe("empty");
    const error = presentJobsList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: false,
      items: [],
      searching: false,
      error: { message: "Could not load jobs. Try again.", retryable: true },
    });
    expect(error.kind).toBe("error");
    expect(error.showRetry).toBe(true);
    expect(error.showCreate).toBe(true);
    const loaded = presentJobsList({
      authStatus: "authenticated",
      loading: false,
      loadedOnce: true,
      items: [job],
      searching: false,
    });
    expect(loaded.kind).toBe("loaded");
    expect(loaded.items).toHaveLength(1);
  });

  it("keeps cached jobs offline and blocks create until reconnected", () => {
    const offline = presentJobsList({
      authStatus: "offline_cached",
      loading: false,
      loadedOnce: true,
      items: [job],
      searching: true,
    });
    expect(offline.showOfflineBanner).toBe(true);
    expect(offline.showCreate).toBe(true);
    expect(offline.showSearchDownloaded).toBe(true);
    expect(createJobDisabled("offline_cached", false)).toBe(false);
    expect(createJobDisabled("authenticated", false)).toBe(false);
    expect(createJobDisabled("access_expired", false)).toBe(true);
    expect(canOpenCreateJob("authenticated")).toBe(true);
  });

  it("presents detail loading, missing, and draft next-action copy", () => {
    expect(presentJobDetail({ authStatus: "authenticated", loading: true }).kind).toBe("loading");
    expect(
      presentJobDetail({
        authStatus: "authenticated",
        loading: false,
        error: { message: "missing", retryable: false, status: 404 },
      }).kind,
    ).toBe("missing");
    expect(nextActionCopy("quote", "draft")).toBe("quote");
    expect(nextActionCopy("direct_invoice", "draft")).toBe("direct");
    expect(nextActionCopy("quote", "active")).toBe("published");
    expect(nextActionCopy("quote", "active", "declined")).toBe("quote");
    expect(nextActionCopy("quote", "active", "accepted")).toBe("invoice");
    expect(nextActionCopy("quote", "invoiced", "accepted", true)).toBe("view_invoice");
    expect(nextActionCopy("quote", "invoiced", "accepted", false)).toBe("replace_invoice");
    expect(nextActionCopy("quote", "active", "expired")).toBe("quote");
    expect(nextActionCopy("quote", "active", "superseded")).toBe("quote");
    expect(nextActionCopy("quote", "canceled")).toBe("none");
    expect(nextActionCopy("quote", "canceled", "accepted", true)).toBe("view_invoice");
    const canceled = jobLifecycleActions({
      lifecycle: "canceled",
      permitted_actions: ["create_linked_job", "view_invoice"],
      active_invoice: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        number: "INV-000001",
        revision_no: 1,
        lifecycle: "issued",
        total_cents: 1000,
        due_date: null,
      },
      latest_invoice: null,
    });
    expect(canceled.canCreateLinked).toBe(true);
    expect(canceled.showReceivable).toBe(true);
    expect(canceled.canDelete).toBe(false);
    expect(canceled.canArchive).toBe(false);
    expect(canceled.canFinish).toBe(false);
    const finished = jobLifecycleActions({
      lifecycle: "finished",
      permitted_actions: ["archive_job", "view_invoice"],
      active_invoice: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        number: "INV-000001",
        revision_no: 1,
        lifecycle: "issued",
        total_cents: 1000,
        due_date: null,
      },
      latest_invoice: null,
    });
    expect(finished.canArchive).toBe(true);
    expect(finished.canFinish).toBe(false);
    expect(finished.canRestore).toBe(false);
    expect(nextActionCopy("quote", "finished", "accepted", true)).toBe("view_invoice");
    expect(nextActionCopy("quote", "archived", "accepted", true)).toBe("view_invoice");
    expect(nextActionCopy("quote", "active", "withdrawn")).toBe("quote");
  });

  it("keeps cached job content when a refresh fails and hides it when access expires", () => {
    const detail = detailJob();
    expect(
      presentJobDetail({
        authStatus: "authenticated",
        loading: true,
        job: detail,
      }).kind,
    ).toBe("loaded");
    const failed = presentJobDetail({
      authStatus: "authenticated",
      loading: false,
      job: detail,
      error: { message: "Could not refresh this job. Showing the last saved copy.", retryable: true, status: 0 },
    });
    expect(failed.kind).toBe("loaded");
    expect(failed.refreshFailed).toBe(true);
    expect(failed.showRetry).toBe(true);
    expect(failed.job?.title).toBe("Northside porch");
    expect(
      presentJobDetail({
        authStatus: "access_expired",
        loading: false,
        job: detail,
      }).job,
    ).toBeUndefined();
    expect(
      presentJobDetail({
        authStatus: "offline_cached",
        loading: false,
        error: { message: "offline", retryable: true, status: 0 },
      }).kind,
    ).toBe("offline");
  });
});

function detailJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    customer_name: "Riley",
    title: "Northside porch",
    lifecycle: "draft",
    mode: "quote",
    no_site: true,
    version: 1,
    created_at: "2026-09-26T14:00:00.000Z",
    updated_at: "2026-09-26T14:00:00.000Z",
    site_address: null,
    internal_notes: "",
    permitted_actions: ["delete_job"],
    quote_draft: null,
    current_quote: null,
    active_invoice: null,
    latest_invoice: null,
    change_draft: null,
    latest_change: null,
    ...overrides,
  };
}

describe("job overview presentation", () => {
  it("shows create quote for a draft and open quote when a draft exists", () => {
    expect(presentCurrentStep(detailJob()).label).toBe("Create quote");
    expect(presentJobDocuments(detailJob())).toEqual([]);
    expect(presentScopeTotalCents(detailJob())).toBeNull();
    const drafted = detailJob({
      quote_draft: { id: "q", version: 1, line_count: 1, net_cents: 100000, tax_cents: 4000, total_cents: 104000 },
    });
    expect(presentCurrentStep(drafted).label).toBe("Open quote");
    expect(presentScopeTotalCents(drafted)).toBe(104000);
  });

  it("routes a direct-invoice draft to create invoice", () => {
    const direct = detailJob({ mode: "direct_invoice", permitted_actions: [] });
    expect(nextActionCopy(direct.mode, direct.lifecycle)).toBe("direct");
    expect(presentCurrentStep(direct).label).toBe("Create invoice");
    expect(presentModePill(direct)).toBe("Direct invoice");
  });

  it("shows an approved extra once and uses the new agreed job total", () => {
    const job = detailJob({
      lifecycle: "active",
      current_quote: { id: "q", number: "Q-000004", revision_no: 1, lifecycle: "accepted", total_cents: 8568 },
      latest_change: {
        id: "7be2b825-7ec5-487b-9274-d1b38f0acbf0",
        number: "CO-000001",
        revision_no: 1,
        lifecycle: "accepted",
        total_cents: 18568,
        request_state: "approved",
        additions: [{ description: "Hjk", total_cents: 10000 }],
      },
    });
    expect(presentScopeTotalCents(job)).toBe(18568);
    const documents = presentJobDocuments(job);
    expect(documents.filter((row) => row.title === "Hjk")).toHaveLength(1);
    expect(documents.find((row) => row.title === "CO-000001")?.subtitle).toContain("approved");
  });

  it("presents issued, accepted, declined, expired, superseded, and withdrawn quotes", () => {
    const issued = detailJob({
      lifecycle: "active",
      permitted_actions: ["cancel_job"],
      current_quote: { id: "q", number: "Q-0018", revision_no: 1, lifecycle: "issued", total_cents: 104000 },
    });
    expect(nextActionCopy(issued.mode, issued.lifecycle, "issued")).toBe("published");
    expect(presentModePill(issued)).toBe("Quote Q-0018");
    expect(presentJobDocuments(issued).map((row) => row.title)).toEqual(["Quote Q-0018"]);
    const accepted = detailJob({
      lifecycle: "active",
      current_quote: { id: "q", number: "Q-0018", revision_no: 1, lifecycle: "accepted", total_cents: 104000 },
    });
    expect(presentCurrentStep(accepted).label).toBe("Ready to invoice");
    expect(presentJobDocuments(accepted).map((row) => row.action)).toEqual(["quote", "request"]);
    for (const lifecycle of ["declined", "expired", "superseded", "withdrawn"] as const) {
      expect(nextActionCopy("quote", "active", lifecycle)).toBe("quote");
      expect(
        presentCurrentStep(
          detailJob({
            lifecycle: "active",
            current_quote: { id: "q", number: "Q-0018", revision_no: 1, lifecycle, total_cents: 104000 },
          }),
        ).label,
      ).toBe("Create revision");
    }
  });

  it("shows a canceled receivable only from the invoice and offers a linked job", () => {
    const canceled = detailJob({
      lifecycle: "canceled",
      permitted_actions: ["create_linked_job"],
      current_quote: { id: "q", number: "Q-0018", revision_no: 1, lifecycle: "accepted", total_cents: 104000 },
      active_invoice: {
        id: "inv",
        number: "INV-000001",
        revision_no: 1,
        lifecycle: "issued",
        total_cents: 25000,
        due_date: null,
      },
    });
    expect(presentReceivableCents(canceled)).toBe(25000);
    expect(presentScopeTotalCents(canceled)).toBe(104000);
    expect(jobLifecycleActions(canceled).canCreateLinked).toBe(true);
    expect(jobLifecycleActions(canceled).canCancel).toBe(false);
    expect(presentReceivableCents(detailJob({ lifecycle: "canceled" }))).toBeNull();
  });

  it("lists issued credit notes so the owner can open their PDFs", () => {
    const job = detailJob({
      lifecycle: "invoiced",
      permitted_actions: ["view_invoice"],
      active_invoice: {
        id: "inv",
        number: "INV-000001",
        revision_no: 1,
        lifecycle: "issued",
        total_cents: 25980,
        due_date: null,
      },
      issued_credits: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          number: "CN-000001",
          revision_no: 1,
          lifecycle: "issued",
          total_cents: 2165,
          pdf_state: "ready",
          invoice_id: "inv",
        },
      ],
    });
    expect(presentJobDocuments(job)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "CN-000001",
          subtitle: "Issued credit note · PDF",
          action: "credit",
          targetId: "11111111-1111-4111-8111-111111111111",
        }),
      ]),
    );
  });

  it("hides finish and archive until the server permits them", () => {
    const invoiced = detailJob({
      lifecycle: "invoiced",
      permitted_actions: ["view_invoice"],
      active_invoice: {
        id: "inv",
        number: "INV-000001",
        revision_no: 1,
        lifecycle: "issued",
        total_cents: 104000,
        due_date: null,
      },
    });
    expect(jobLifecycleActions(invoiced).canFinish).toBe(false);
    expect(jobLifecycleActions(invoiced).canArchive).toBe(false);
    const settled = detailJob({
      lifecycle: "invoiced",
      permitted_actions: ["finish_job"],
      active_invoice: invoiced.active_invoice,
    });
    expect(jobLifecycleActions(settled).canFinish).toBe(true);
    const archived = detailJob({ lifecycle: "archived", permitted_actions: ["restore_job"] });
    expect(jobLifecycleActions(archived).canRestore).toBe(true);
    expect(jobLifecycleActions(archived).canArchive).toBe(false);
    expect(jobLifecycleActions(archived).canDelete).toBe(false);
  });

  it("fails closed when permitted_actions is missing, null, empty, or malformed", () => {
    const invoice = {
      id: "inv",
      number: "INV-000001",
      revision_no: 1,
      lifecycle: "issued",
      total_cents: 25000,
      due_date: null,
    };
    const base = detailJob({
      lifecycle: "canceled",
      active_invoice: invoice,
      latest_invoice: null,
    });
    const { permitted_actions: omitted, ...cachedWithoutField } = base;
    void omitted;
    const cases: Array<{ name: string; permitted_actions?: unknown }> = [
      { name: "missing" },
      { name: "null", permitted_actions: null },
      { name: "malformed object", permitted_actions: { delete_job: true } },
      { name: "malformed string", permitted_actions: "delete_job" },
      { name: "malformed mixed array", permitted_actions: ["delete_job", 1] },
      { name: "empty", permitted_actions: [] },
    ];
    for (const item of cases) {
      const job =
        item.name === "missing"
          ? cachedWithoutField
          : { ...base, permitted_actions: item.permitted_actions };
      const actions = jobLifecycleActions(job);
      expect(actions.canDelete).toBe(false);
      expect(actions.canCancel).toBe(false);
      expect(actions.canCreateLinked).toBe(false);
      expect(actions.canArchive).toBe(false);
      expect(actions.canRestore).toBe(false);
      expect(actions.canFinish).toBe(false);
      expect(actions.showReceivable).toBe(true);
      expect(jobPermitsAction(job, "create_change")).toBe(false);
      expect(normalizePermittedActions(item.name === "missing" ? undefined : item.permitted_actions)).toEqual([]);
    }
    const parsed = JSON.parse(JSON.stringify(cachedWithoutField)) as typeof cachedWithoutField;
    expect(parsed).not.toHaveProperty("permitted_actions");
    expect(jobLifecycleActions(parsed).canDelete).toBe(false);
    const presented = presentJobDetail({
      authStatus: "authenticated",
      loading: false,
      job: parsed,
    });
    expect(presented.kind).toBe("loaded");
    expect(presented.job?.permitted_actions).toEqual([]);
    expect(presented.job?.title).toBe("Northside porch");
  });

  it("keeps server actions when permitted_actions is a valid string array", () => {
    const valid = [
      "delete_job",
      "cancel_job",
      "create_linked_job",
      "archive_job",
      "restore_job",
      "finish_job",
      "create_change",
    ];
    const job = detailJob({ permitted_actions: valid });
    expect(normalizePermittedActions(valid)).toEqual(valid);
    expect(jobLifecycleActions(job)).toMatchObject({
      canDelete: true,
      canCancel: true,
      canCreateLinked: true,
      canArchive: true,
      canRestore: true,
      canFinish: true,
    });
    expect(jobPermitsAction(job, "create_change")).toBe(true);
    expect(jobPermitsAction(job, "create_invoice")).toBe(false);
    const presented = presentJobDetail({ authStatus: "authenticated", loading: false, job });
    expect(presented.job?.permitted_actions).toBe(valid);
  });

  it("derives activity only from response timestamps and formats the last update", () => {
    const job = detailJob({ updated_at: "2026-09-26T14:02:00.000Z" });
    const activity = presentJobActivity(job);
    expect(activity.map((row) => row.title)).toEqual(["Job updated", "Job created"]);
    expect(JSON.stringify(activity)).not.toContain("Riley");
    expect(presentUpdatedLabel(job.updated_at, Date.parse("2026-09-26T14:02:30.000Z"))).toBe("Updated just now");
    expect(presentUpdatedLabel(job.updated_at, Date.parse("2026-09-26T14:04:00.000Z"))).toBe("Updated 2 min ago");
    expect(analyticsPropertiesAreSafe({ job_lifecycle: "draft", screen: "job_overview" })).toBe(true);
    expect(analyticsPropertiesAreSafe({ customer_name: "Riley", job_title: "Northside porch" })).toBe(false);
  });
});

describe("job navigation", () => {
  it("keeps create and detail under the Jobs tab", () => {
    expect(jobsIndexPath()).toBe("/(tabs)/jobs");
    expect(createJobPath()).toBe("/(tabs)/jobs/new");
    expect(createLinkedJobPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/new?relatedJobId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(jobDetailPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(jobQuotePath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/quote",
    );
    expect(jobPublishPath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/publish",
    );
    expect(jobChangePath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/change",
    );
    expect(jobReducePath("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(
      "/(tabs)/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/reduce",
    );
  });
});
