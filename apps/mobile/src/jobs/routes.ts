export function jobsIndexPath(): string {
  return "/(tabs)/jobs";
}

export function createJobPath(): string {
  return "/(tabs)/jobs/new";
}

export function jobDetailPath(jobId: string): string {
  return `/(tabs)/jobs/${jobId}`;
}

export function canOpenCreateJob(status: string): boolean {
  return status === "authenticated" || status === "offline_cached";
}

export function createJobDisabled(status: string, submitting: boolean): boolean {
  return submitting || status === "access_expired" || status === "offline_cached";
}
