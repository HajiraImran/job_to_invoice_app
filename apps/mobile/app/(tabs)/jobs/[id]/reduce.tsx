import { useLocalSearchParams } from "expo-router";
import { ReductionScreen } from "../../../../src/changes/reduction-screen.tsx";

export default function ReduceScopeScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  return <ReductionScreen jobId={jobId} />;
}
