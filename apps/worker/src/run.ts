import { loadEnv, type LoadedEnv } from "@job-to-invoice/config";

export function workerStatus(env: LoadedEnv): string {
  return `worker foundation idle (${env.APP_ENV}); outbox is not implemented`;
}

export function startWorker(): string {
  return workerStatus(loadEnv());
}
