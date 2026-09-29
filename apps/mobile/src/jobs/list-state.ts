import type { JobSummary } from "./presentation.ts";

/**
 * Jobs list state across filter/search changes, refreshes, and failures.
 * Items always belong to `key`; a failed request never replaces real items with an empty list.
 */
export type JobsListState = {
  key: string;
  generation: number;
  items: JobSummary[];
  nextCursor: string | null;
  source: "none" | "cache" | "network";
  loading: boolean;
  loadedOnce: boolean;
  error?: { message: string; retryable: boolean };
};

export function jobsListKey(listState: string, search: string): string {
  return `${listState}\u0000${search}`;
}

export function initialJobsListState(key: string): JobsListState {
  return { key, generation: 0, items: [], nextCursor: null, source: "none", loading: true, loadedOnce: false };
}

/** Starts a first-page load. The same key keeps what is on screen; a new key starts clean. */
export function beginJobsLoad(prev: JobsListState, key: string): JobsListState {
  const generation = prev.generation + 1;
  if (prev.key !== key) {
    return { ...initialJobsListState(key), generation };
  }
  return { ...prev, generation, loading: true, error: undefined };
}

/** Shows cached rows while the network request is in flight, unless fresher data already landed. */
export function applyCachedJobs(
  prev: JobsListState,
  generation: number,
  items: JobSummary[],
): JobsListState {
  if (generation !== prev.generation || prev.source === "network" || items.length === 0) {
    return prev;
  }
  return { ...prev, items, nextCursor: null, source: "cache", loadedOnce: true };
}

export function applyNetworkJobs(
  prev: JobsListState,
  generation: number,
  page: { items: JobSummary[]; next_cursor: string | null },
  appending = false,
): JobsListState {
  if (!appending && generation !== prev.generation) {
    return prev;
  }
  const items = appending ? mergeAppended(prev.items, page.items) : page.items;
  return {
    ...prev,
    items,
    nextCursor: page.next_cursor,
    source: "network",
    loading: false,
    loadedOnce: true,
    error: undefined,
  };
}

export function applyJobsFailure(
  prev: JobsListState,
  generation: number,
  error: { message: string; retryable: boolean },
): JobsListState {
  if (generation !== prev.generation) {
    return prev;
  }
  return { ...prev, loading: false, error };
}

function mergeAppended(current: JobSummary[], next: JobSummary[]): JobSummary[] {
  const seen = new Set(current.map((job) => job.id));
  return [...current, ...next.filter((job) => !seen.has(job.id))];
}
