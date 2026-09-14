const ROLE_TOKEN = ["service", "role"].join("_");
const BYPASS_TOKEN = ["BYPASS", "RLS"].join("");
const SUPABASE_SERVICE_TOKEN = ["SUPABASE", "SERVICE", "ROLE"].join("_");

export function findForbiddenSecrets(source: string): string[] {
  const hits: string[] = [];
  if (source.toLowerCase().includes(ROLE_TOKEN)) {
    hits.push(ROLE_TOKEN);
  }
  if (source.toUpperCase().includes(BYPASS_TOKEN)) {
    hits.push(BYPASS_TOKEN);
  }
  if (source.toUpperCase().includes(SUPABASE_SERVICE_TOKEN)) {
    hits.push(SUPABASE_SERVICE_TOKEN);
  }
  return hits;
}
