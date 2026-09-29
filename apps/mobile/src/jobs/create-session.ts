import type { JobFormValues } from "./form.ts";

let held: JobFormValues | undefined;

export function holdCreateJobForm(values: JobFormValues): void {
  held = { ...values };
}

export function peekCreateJobForm(): JobFormValues | undefined {
  return held ? { ...held } : undefined;
}

export function clearCreateJobForm(): void {
  held = undefined;
}
