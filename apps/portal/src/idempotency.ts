export class PortalIdentifierError extends Error {
  constructor() {
    super("unavailable");
    this.name = "PortalIdentifierError";
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hexFromBytes(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function uuidFromRandomBytes(bytes: Uint8Array): string {
  const version = bytes.at(6);
  const variant = bytes.at(8);
  if (version === undefined || variant === undefined) {
    throw new PortalIdentifierError();
  }
  bytes[6] = (version & 0x0f) | 0x40;
  bytes[8] = (variant & 0x3f) | 0x80;
  const hex = hexFromBytes(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createIdempotencyKey(): string {
  const cryptoImpl = globalThis.crypto;
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
    try {
      const value = cryptoImpl.randomUUID();
      if (UUID_V4.test(value)) {
        return value;
      }
    } catch {
      /* fall through to getRandomValues */
    }
  }
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === "function") {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
    return uuidFromRandomBytes(bytes);
  }
  throw new PortalIdentifierError();
}

export type PortalDecisionPayload = {
  decision: "approve" | "decline";
  signer_name: string;
  consent_version: string;
  consent_accepted: boolean;
  snapshot_sha256: string;
  comment?: string;
};

export async function postPortalDecision(input: {
  fetchImpl?: typeof fetch;
  csrf: string;
  payload: PortalDecisionPayload;
}): Promise<Response> {
  const idempotencyKey = createIdempotencyKey();
  const fetchImpl = input.fetchImpl ?? fetch;
  return fetchImpl("/api/portal/decision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": input.csrf,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(input.payload),
  });
}
