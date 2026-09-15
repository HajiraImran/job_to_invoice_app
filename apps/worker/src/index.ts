import { startWorker } from "./run.ts";

const message = await startWorker();
console.info(message);

if (process.env.WORKER_ONCE === "true") {
  process.exit(0);
}
