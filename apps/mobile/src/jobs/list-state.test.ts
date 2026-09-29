import { describe, expect, it } from "vitest";
import {
  applyCachedJobs,
  applyJobsFailure,
  applyNetworkJobs,
  beginJobsLoad,
  initialJobsListState,
  jobsListKey,
} from "./list-state.ts";
import { presentJobsList, type JobSummary } from "./presentation.ts";

function job(id: string, title = `Job ${id}`): JobSummary {
  return { id, title, customer_name: "Customer", lifecycle: "active" } as unknown as JobSummary;
}

const ACTIVE = jobsListKey("active", "");
const FINISHED = jobsListKey("finished", "");
const failure = { message: "Could not reach the Job to Invoice server. Try again.", retryable: true };

function view(state: ReturnType<typeof initialJobsListState>, authStatus = "authenticated") {
  return presentJobsList({
    authStatus,
    loading: state.loading,
    loadedOnce: state.loadedOnce,
    items: state.items,
    searching: false,
    error: state.error,
  });
}

describe("jobs list across repeated navigation", () => {
  it("shows cached jobs while the first network load is in flight, then replaces them", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    expect(view(state).kind).toBe("loading");
    state = applyCachedJobs(state, state.generation, [job("1")]);
    expect(view(state)).toMatchObject({ kind: "loaded", refreshing: true });
    state = applyNetworkJobs(state, state.generation, { items: [job("1"), job("2")], next_cursor: null });
    expect(view(state)).toMatchObject({ kind: "loaded", refreshing: false });
    expect(state.items.map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("keeps the list on screen when returning to it and refreshing", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    state = applyNetworkJobs(state, state.generation, { items: [job("1")], next_cursor: null });
    for (let visit = 0; visit < 5; visit += 1) {
      state = beginJobsLoad(state, ACTIVE);
      expect(state.items).toHaveLength(1);
      expect(view(state).kind).toBe("loaded");
      state = applyNetworkJobs(state, state.generation, { items: [job("1")], next_cursor: null });
    }
    expect(state.generation).toBe(6);
  });

  it("never replaces real jobs with an empty list when a refresh fails", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    state = applyNetworkJobs(state, state.generation, { items: [job("1"), job("2")], next_cursor: null });
    state = beginJobsLoad(state, ACTIVE);
    state = applyJobsFailure(state, state.generation, failure);
    const shown = view(state);
    expect(shown.kind).toBe("loaded");
    expect(shown.items).toHaveLength(2);
    expect(shown.message).toBe(failure.message);
  });

  it("shows an error, not an empty list, when the first load fails with nothing cached", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    state = applyCachedJobs(state, state.generation, []);
    state = applyJobsFailure(state, state.generation, failure);
    const shown = view(state);
    expect(shown.kind).toBe("error");
    expect(shown.items).toEqual([]);
    expect(shown.showRetry).toBe(true);
  });

  it("keeps cached jobs when the network fails after they were shown", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    state = applyCachedJobs(state, state.generation, [job("1")]);
    state = applyJobsFailure(state, state.generation, failure);
    expect(view(state)).toMatchObject({ kind: "loaded", message: failure.message });
    expect(state.items).toHaveLength(1);
  });

  it("ignores a slow response from a filter the user already left", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    const activeGeneration = state.generation;
    state = beginJobsLoad(state, FINISHED);
    expect(state.items).toEqual([]);
    state = applyNetworkJobs(state, activeGeneration, { items: [job("active-1")], next_cursor: null });
    state = applyJobsFailure(state, activeGeneration, failure);
    expect(state.items).toEqual([]);
    expect(state.error).toBeUndefined();
    state = applyNetworkJobs(state, state.generation, { items: [job("finished-1")], next_cursor: null });
    expect(state.items.map((item) => item.id)).toEqual(["finished-1"]);
  });

  it("does not let late cache rows overwrite fresher network data", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    state = applyNetworkJobs(state, state.generation, { items: [job("1", "Fresh")], next_cursor: null });
    state = applyCachedJobs(state, state.generation, [job("1", "Stale")]);
    expect(state.items[0]?.title).toBe("Fresh");
  });

  it("appends pages without duplicating jobs", () => {
    let state = beginJobsLoad(initialJobsListState(ACTIVE), ACTIVE);
    state = applyNetworkJobs(state, state.generation, { items: [job("1"), job("2")], next_cursor: "c1" });
    state = applyNetworkJobs(state, state.generation, { items: [job("2"), job("3")], next_cursor: null }, true);
    expect(state.items.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(state.nextCursor).toBeNull();
  });
});
