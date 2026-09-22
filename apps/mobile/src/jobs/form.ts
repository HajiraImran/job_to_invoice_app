import type { JobListState, JobMode } from "@job-to-invoice/schemas";
import { parseJobCreate } from "@job-to-invoice/schemas";

export type JobFormValues = {
  customer_name: string;
  title: string;
  no_site: boolean;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  internal_notes: string;
  mode: JobMode | "";
};

export function emptyJobForm(): JobFormValues {
  return {
    customer_name: "",
    title: "",
    no_site: false,
    line1: "",
    line2: "",
    city: "",
    state: "",
    postal_code: "",
    internal_notes: "",
    mode: "",
  };
}

export function jobRequestFromForm(
  values: JobFormValues,
  id: string,
  relatedJobId?: string,
): ReturnType<typeof parseJobCreate> {
  const body: Record<string, unknown> = {
    id,
    customer_name: values.customer_name,
    title: values.title,
    no_site: values.no_site,
    internal_notes: values.internal_notes,
    mode: values.mode,
  };
  if (relatedJobId) {
    body.related_job_id = relatedJobId;
  }
  if (!values.no_site) {
    body.site_address = {
      line1: values.line1,
      city: values.city,
      state: values.state,
      postal_code: values.postal_code,
    };
    if (values.line2.trim()) {
      (body.site_address as Record<string, unknown>).line2 = values.line2;
    }
  }
  return parseJobCreate(body);
}

export function firstJobFieldError(errors: Record<string, string>): string | undefined {
  const order = [
    "customer_name",
    "title",
    "mode",
    "no_site",
    "site_address",
    "site_address.line1",
    "line1",
    "site_address.city",
    "city",
    "site_address.state",
    "state",
    "site_address.postal_code",
    "postal_code",
    "internal_notes",
  ];
  return order.find((field) => errors[field]);
}

export function jobFormFocusName(field: string): string {
  if (field.startsWith("site_address.")) {
    return field.slice("site_address.".length);
  }
  if (field === "site_address") {
    return "line1";
  }
  return field;
}

export function listStateFromFilter(filter: "active" | "finished" | "archived"): JobListState {
  if (filter === "finished") {
    return "finished";
  }
  if (filter === "archived") {
    return "archived";
  }
  return "open";
}
