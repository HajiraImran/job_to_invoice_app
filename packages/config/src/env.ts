import { z } from "zod";
import { PLACEHOLDER_PATTERN } from "./placeholders.ts";
import {
  resolveDocumentsStorage,
  type DocumentsStorageConfig,
} from "./storage.ts";

export { PLACEHOLDER_PATTERN };

const APP_ENVS = ["development", "staging", "production"] as const;
export type AppEnvName = (typeof APP_ENVS)[number];

function nonEmpty(name: string) {
  return z.string().trim().min(1, `${name} is required`);
}

function secret(name: string) {
  return nonEmpty(name).refine(
    (value) => !PLACEHOLDER_PATTERN.test(value),
    `${name} must not use a placeholder value`,
  );
}

function httpsUrl(name: string) {
  return secret(name).refine((value) => value.startsWith("https://"), `${name} must be https`);
}

const optionalStorageShape = {
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_DOWNLOAD_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_DOCUMENTS_BUCKET: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: z.string().optional(),
  STORAGE_WORKER_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_WORKER_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_API_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_API_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_DOCUMENTS_BUCKET: z.string().optional(),
  R2_WORKER_ACCESS_KEY_ID: z.string().optional(),
  R2_WORKER_SECRET_ACCESS_KEY: z.string().optional(),
  R2_API_ACCESS_KEY_ID: z.string().optional(),
  R2_API_SECRET_ACCESS_KEY: z.string().optional(),
};

const publicShape = {
  APP_ENV: z.enum(APP_ENVS),
  PUBLIC_APP_NAME: z.string().min(1).default("Job to Invoice"),
  SUPPORT_URL: z.string().optional(),
  OWNER_APP_BUNDLE_ID: z.string().optional(),
  API_BASE_URL: z.string().optional(),
  PORTAL_ORIGIN: z.string().optional(),
  AUTH_PROJECT_URL: z.string().optional(),
  AUTH_PUBLISHABLE_KEY: z.string().optional(),
  REVENUECAT_PUBLIC_IOS_KEY: z.string().optional(),
  MONTHLY_PRODUCT_ID: z.string().optional(),
  ANNUAL_PRODUCT_ID: z.string().optional(),
  ERROR_REPORTING_DSN: z.string().optional(),
  FEATURE_NEW_PUBLICATION: z.enum(["true", "false"]).optional(),
  FEATURE_PURCHASES: z.enum(["true", "false"]).optional(),
};

const developmentSchema = z.object({
  ...publicShape,
  APP_ENV: z.literal("development"),
  API_BASE_URL: z.string().default("http://localhost:3001"),
  PORTAL_ORIGIN: z.string().default("http://localhost:3000"),
  AUTH_ISSUER: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
  AUTH_JWKS_JSON: z.string().optional(),
  DATABASE_URL_API: z.string().optional(),
  DATABASE_URL_WORKER: z.string().optional(),
  ...optionalStorageShape,
});

const stagingSchema = z.object({
  ...publicShape,
  APP_ENV: z.literal("staging"),
  API_BASE_URL: httpsUrl("API_BASE_URL"),
  PORTAL_ORIGIN: httpsUrl("PORTAL_ORIGIN"),
  AUTH_PROJECT_URL: httpsUrl("AUTH_PROJECT_URL"),
  AUTH_PUBLISHABLE_KEY: secret("AUTH_PUBLISHABLE_KEY"),
  AUTH_ISSUER: secret("AUTH_ISSUER"),
  AUTH_AUDIENCE: secret("AUTH_AUDIENCE"),
  DATABASE_URL_API: secret("DATABASE_URL_API"),
  DATABASE_URL_WORKER: secret("DATABASE_URL_WORKER"),
  DATABASE_URL_PURGE: secret("DATABASE_URL_PURGE"),
  DATABASE_URL_MIGRATIONS: secret("DATABASE_URL_MIGRATIONS"),
  ...optionalStorageShape,
});

const productionSchema = z.object({
  ...publicShape,
  APP_ENV: z.literal("production"),
  PUBLIC_APP_NAME: secret("PUBLIC_APP_NAME"),
  SUPPORT_URL: httpsUrl("SUPPORT_URL"),
  OWNER_APP_BUNDLE_ID: secret("OWNER_APP_BUNDLE_ID"),
  API_BASE_URL: httpsUrl("API_BASE_URL"),
  PORTAL_ORIGIN: httpsUrl("PORTAL_ORIGIN"),
  AUTH_PROJECT_URL: httpsUrl("AUTH_PROJECT_URL"),
  AUTH_PUBLISHABLE_KEY: secret("AUTH_PUBLISHABLE_KEY"),
  AUTH_ISSUER: secret("AUTH_ISSUER"),
  AUTH_AUDIENCE: secret("AUTH_AUDIENCE"),
  DATABASE_URL_API: secret("DATABASE_URL_API"),
  DATABASE_URL_WORKER: secret("DATABASE_URL_WORKER"),
  DATABASE_URL_PURGE: secret("DATABASE_URL_PURGE"),
  DATABASE_URL_MIGRATIONS: secret("DATABASE_URL_MIGRATIONS"),
  ...optionalStorageShape,
  APPROVAL_TOKEN_HASH_KEY: secret("APPROVAL_TOKEN_HASH_KEY"),
  OTP_HASH_KEY: secret("OTP_HASH_KEY"),
  APPROVAL_EVIDENCE_ENCRYPTION_KEY: secret("APPROVAL_EVIDENCE_ENCRYPTION_KEY"),
  REVENUECAT_PUBLIC_IOS_KEY: secret("REVENUECAT_PUBLIC_IOS_KEY"),
  REVENUECAT_SECRET_KEY: secret("REVENUECAT_SECRET_KEY"),
  WEBHOOK_AUTH_SECRET: secret("WEBHOOK_AUTH_SECRET"),
  MONTHLY_PRODUCT_ID: secret("MONTHLY_PRODUCT_ID"),
  ANNUAL_PRODUCT_ID: secret("ANNUAL_PRODUCT_ID"),
  EMAIL_API_KEY: secret("EMAIL_API_KEY"),
  EMAIL_WEBHOOK_SECRET: secret("EMAIL_WEBHOOK_SECRET"),
  EMAIL_FROM_DOMAIN: secret("EMAIL_FROM_DOMAIN"),
  ERROR_REPORTING_DSN: secret("ERROR_REPORTING_DSN"),
  STAFF_AUTH_CONFIG: secret("STAFF_AUTH_CONFIG"),
  BACKUP_RETENTION_DAYS: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => Number(value) >= 1 && Number(value) <= 35, "BACKUP_RETENTION_DAYS must be 1–35"),
  FEATURE_NEW_PUBLICATION: z.enum(["true", "false"]),
  FEATURE_PURCHASES: z.enum(["true", "false"]),
  LIMITS_VERSION: secret("LIMITS_VERSION"),
});

export type LoadedEnv = (
  | z.infer<typeof developmentSchema>
  | z.infer<typeof stagingSchema>
  | z.infer<typeof productionSchema>
) & {
  documentsStorage?: DocumentsStorageConfig;
};

function schemaFor(appEnv: string | undefined) {
  if (appEnv === "production") {
    return productionSchema;
  }
  if (appEnv === "staging") {
    return stagingSchema;
  }
  return developmentSchema;
}

export function loadEnv(source: NodeJS.Dict<string> = process.env): LoadedEnv {
  const appEnv = source.APP_ENV ?? "development";
  const parsed = schemaFor(appEnv).safeParse({ ...source, APP_ENV: appEnv });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${appEnv} configuration (QA68): ${details}`);
  }
  try {
    const documentsStorage = resolveDocumentsStorage({
      ...parsed.data,
      APP_ENV: parsed.data.APP_ENV,
    });
    return { ...parsed.data, documentsStorage };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid storage configuration";
    throw new Error(`Invalid ${appEnv} configuration (QA68): ${message}`, { cause: error });
  }
}
