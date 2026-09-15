import { PLACEHOLDER_PATTERN } from "./placeholders.ts";

export const DEVELOPMENT_DOCUMENTS_BUCKET = "job-to-invoice-documents-development";
export const PRODUCTION_DOCUMENTS_BUCKET = "job-to-invoice-documents-production";

export type DocumentsCredentialPair = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type DocumentsStorageConfig = {
  endpoint: string;
  downloadEndpoint?: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  worker: DocumentsCredentialPair;
  api: DocumentsCredentialPair;
};

export type S3CompatibleClientOptions = {
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  credentials: DocumentsCredentialPair;
};

const STORAGE_FIELD_NAMES = [
  "STORAGE_ENDPOINT",
  "STORAGE_DOWNLOAD_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_DOCUMENTS_BUCKET",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_WORKER_ACCESS_KEY_ID",
  "STORAGE_WORKER_SECRET_ACCESS_KEY",
  "STORAGE_API_ACCESS_KEY_ID",
  "STORAGE_API_SECRET_ACCESS_KEY",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function isRfc1918Host(hostname: string): boolean {
  const octets = isIpv4(hostname);
  if (!octets || octets.length !== 4) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) {
    return false;
  }
  if (first === 10) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  return first === 172 && second >= 16 && second <= 31;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  return isLoopbackHost(hostname) || isRfc1918Host(hostname);
}

export function documentsBucket(appEnv: string, override?: string): string {
  if (override && override.trim()) {
    return override.trim();
  }
  if (appEnv === "production") {
    return PRODUCTION_DOCUMENTS_BUCKET;
  }
  if (appEnv === "development") {
    return DEVELOPMENT_DOCUMENTS_BUCKET;
  }
  throw new Error("STORAGE_DOCUMENTS_BUCKET is required");
}

export function assertStorageEndpoint(value: string, appEnv: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (appEnv === "development") {
    if (url.protocol === "http:" && !isPrivateOrLocalHost(url.hostname)) {
      throw new Error(`${name} HTTP is only allowed on localhost or RFC1918 addresses in development`);
    }
    return url;
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be https`);
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error(`${name} must not use a local or private address outside development`);
  }
  return url;
}

export function assertNoPublicStorageSecrets(source: NodeJS.Dict<string>): void {
  if (present(source.STORAGE_SERVICE_KEY)) {
    throw new Error("STORAGE_SERVICE_KEY is not allowed");
  }
  for (const key of Object.keys(source)) {
    if (!key.startsWith("EXPO_PUBLIC_")) {
      continue;
    }
    if (/STORAGE|R2_|ACCESS_KEY|SECRET/.test(key)) {
      throw new Error("Storage credentials must not be exposed through EXPO_PUBLIC_*");
    }
  }
}

function parseForcePathStyle(value: string | undefined, required: boolean): boolean | undefined {
  const raw = present(value);
  if (!raw) {
    if (required) {
      throw new Error("STORAGE_FORCE_PATH_STYLE is required");
    }
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error("STORAGE_FORCE_PATH_STYLE must be true or false");
}

export function resolveDocumentsStorage(
  source: NodeJS.Dict<string> & { APP_ENV: string },
): DocumentsStorageConfig | undefined {
  assertNoPublicStorageSecrets(source);
  const appEnv = source.APP_ENV;
  const endpoint = present(source.STORAGE_ENDPOINT);
  const downloadEndpoint = present(source.STORAGE_DOWNLOAD_ENDPOINT);
  const region = present(source.STORAGE_REGION);
  const bucketOverride = present(source.STORAGE_DOCUMENTS_BUCKET);
  const workerKey = present(source.STORAGE_WORKER_ACCESS_KEY_ID);
  const workerSecret = present(source.STORAGE_WORKER_SECRET_ACCESS_KEY);
  const apiKey = present(source.STORAGE_API_ACCESS_KEY_ID);
  const apiSecret = present(source.STORAGE_API_SECRET_ACCESS_KEY);
  const required = appEnv !== "development";
  const anySet = STORAGE_FIELD_NAMES.some((name) => present(source[name]));

  if (!required && !anySet) {
    return undefined;
  }

  if (!endpoint) {
    throw new Error("STORAGE_ENDPOINT is required");
  }
  if (!region) {
    throw new Error("STORAGE_REGION is required");
  }
  if (!workerKey || !workerSecret) {
    throw new Error("worker storage credentials are required");
  }
  if (!apiKey || !apiSecret) {
    throw new Error("API storage credentials are required");
  }
  const forcePathStyle = parseForcePathStyle(source.STORAGE_FORCE_PATH_STYLE, true);
  if (forcePathStyle === undefined) {
    throw new Error("STORAGE_FORCE_PATH_STYLE is required");
  }
  if (workerKey === apiKey || workerSecret === apiSecret) {
    throw new Error("worker and API storage credentials must be different");
  }
  for (const [name, value] of [
    ["STORAGE_ENDPOINT", endpoint],
    ["STORAGE_DOWNLOAD_ENDPOINT", downloadEndpoint],
    ["STORAGE_REGION", region],
    ["STORAGE_DOCUMENTS_BUCKET", bucketOverride],
    ["STORAGE_WORKER_ACCESS_KEY_ID", workerKey],
    ["STORAGE_WORKER_SECRET_ACCESS_KEY", workerSecret],
    ["STORAGE_API_ACCESS_KEY_ID", apiKey],
    ["STORAGE_API_SECRET_ACCESS_KEY", apiSecret],
  ] as const) {
    if (value && PLACEHOLDER_PATTERN.test(value)) {
      throw new Error(`${name} must not use a placeholder value`);
    }
  }

  assertStorageEndpoint(endpoint, appEnv, "STORAGE_ENDPOINT");
  if (downloadEndpoint) {
    assertStorageEndpoint(downloadEndpoint, appEnv, "STORAGE_DOWNLOAD_ENDPOINT");
  }

  return {
    endpoint,
    downloadEndpoint,
    region,
    bucket: documentsBucket(appEnv, bucketOverride),
    forcePathStyle,
    worker: { accessKeyId: workerKey, secretAccessKey: workerSecret },
    api: { accessKeyId: apiKey, secretAccessKey: apiSecret },
  };
}

export function workerClientOptions(config: DocumentsStorageConfig): S3CompatibleClientOptions {
  return {
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.worker,
  };
}

export function apiClientOptions(config: DocumentsStorageConfig): S3CompatibleClientOptions {
  return {
    region: config.region,
    endpoint: config.downloadEndpoint ?? config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.api,
  };
}
