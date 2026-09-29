import { useLocalSearchParams } from "expo-router";
import { ExtraWorkScreen } from "../../../../src/changes/extra-work-screen.tsx";

export default function ChangeRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? (params.id[0] ?? "") : "";
  return <ExtraWorkScreen jobId={jobId} />;
}
