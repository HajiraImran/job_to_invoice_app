import { parseCustomerCreate, parseCustomerPatch } from "@job-to-invoice/schemas";

export type CustomerFormValues = {
  name: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  confirm_duplicate_email: boolean;
};

export function emptyCustomerForm(): CustomerFormValues {
  return {
    name: "",
    email: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postal_code: "",
    confirm_duplicate_email: false,
  };
}

function addressFromForm(values: CustomerFormValues): Record<string, unknown> | null {
  if (!values.line1.trim() && !values.city.trim() && !values.state.trim() && !values.postal_code.trim() && !values.line2.trim()) {
    return null;
  }
  const address: Record<string, unknown> = {
    line1: values.line1,
    city: values.city,
    state: values.state,
    postal_code: values.postal_code,
  };
  if (values.line2.trim()) {
    address.line2 = values.line2;
  }
  return address;
}

function contactBody(values: CustomerFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = { name: values.name };
  if (values.email.trim()) {
    body.email = values.email;
  }
  if (values.phone.trim()) {
    body.phone = values.phone;
  }
  const address = addressFromForm(values);
  if (address) {
    body.billing_address = address;
  }
  if (values.confirm_duplicate_email) {
    body.confirm_duplicate_email = true;
  }
  return body;
}

export const CUSTOMER_EMAIL_REQUIRED = "Enter an email address.";

export function customerCreateFromForm(values: CustomerFormValues, id?: string) {
  const body = contactBody(values);
  if (id) {
    body.id = id;
  }
  const parsed = parseCustomerCreate(body);
  if (values.email.trim()) {
    return parsed;
  }
  const field_errors = parsed.ok ? [] : parsed.field_errors.filter((item) => item.field !== "email");
  return {
    ok: false as const,
    field_errors: [{ field: "email", message: CUSTOMER_EMAIL_REQUIRED }, ...field_errors],
  };
}

export function customerPatchFromForm(values: CustomerFormValues, original: CustomerFormValues) {
  const body: Record<string, unknown> = {};
  if (values.name !== original.name) body.name = values.name;
  if (values.email !== original.email) body.email = values.email.trim() ? values.email : null;
  if (values.phone !== original.phone) body.phone = values.phone.trim() ? values.phone : null;
  if (
    values.line1 !== original.line1 ||
    values.line2 !== original.line2 ||
    values.city !== original.city ||
    values.state !== original.state ||
    values.postal_code !== original.postal_code
  ) {
    body.billing_address = addressFromForm(values);
  }
  if (values.confirm_duplicate_email) {
    body.confirm_duplicate_email = true;
  }
  return parseCustomerPatch(body);
}

export function customerMutationDenied(authStatus: string): boolean {
  return authStatus !== "authenticated";
}

export function firstCustomerFieldError(errors: Record<string, string>): string | undefined {
  const order = [
    "name",
    "email",
    "phone",
    "billing_address",
    "billing_address.line1",
    "billing_address.city",
    "billing_address.state",
    "billing_address.postal_code",
  ];
  return order.find((field) => errors[field]);
}
