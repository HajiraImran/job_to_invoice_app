import { useLocalSearchParams } from "expo-router";
import { ChangeEditorScreen } from "../../../../src/changes/editor.tsx";

export default function ReduceScopeScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  return <ChangeEditorScreen jobId={jobId} mode="reductions" />;
}
