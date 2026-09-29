-- Extra work used to POST a new empty editing change draft whenever the
-- screen focused after a published change. That leftover is not owner-started
-- extra work. Invoice freeze still blocks a first empty extra-work editor
-- (no published change) and any in-progress extra with lines.
-- Forward-only. Do not edit 0001–0029. Grants on replaced functions are
-- preserved by CREATE OR REPLACE.

set role migrator;

create or replace function commercial.change_draft_is_invoice_blocker(
  p_workspace_id uuid,
  p_job_id uuid,
  p_payload jsonb
) returns boolean
language sql
stable
parallel safe
set search_path = identity, commercial, pg_temp
as $$
  select not (
    coalesce(jsonb_array_length(coalesce(p_payload->'additions', '[]'::jsonb)), 0) = 0
    and coalesce(jsonb_array_length(coalesce(p_payload->'reductions', '[]'::jsonb)), 0) = 0
    and exists (
      select 1
        from commercial.documents doc
       where doc.workspace_id = p_workspace_id
         and doc.job_id = p_job_id
         and doc.kind = 'change'
         and doc.lifecycle in ('issued', 'accepted', 'declined')
    )
  );
$$;

revoke all on function commercial.change_draft_is_invoice_blocker(uuid, uuid, jsonb) from public;
grant execute on function commercial.change_draft_is_invoice_blocker(uuid, uuid, jsonb) to api_app;
revoke all on function commercial.change_draft_is_invoice_blocker(uuid, uuid, jsonb)
  from anon, authenticated, worker_app, purge_app;

do $patch$
declare
  def text;
  patched text;
  replacement text := $r$and d.kind = 'change'
    and d.draft_state = 'editing'
    and commercial.change_draft_is_invoice_blocker(d.workspace_id, d.job_id, d.payload_json)$r$;
begin
  select pg_get_functiondef(
    'commercial.freeze_invoice_preview(uuid, uuid, text, bytea, jsonb, timestamptz)'::regprocedure
  ) into def;
  def := regexp_replace(def, '^CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  if position('change_draft_is_invoice_blocker' in def) = 0 then
    if def !~ 'and d\.kind = ''change''[[:space:]]+and d\.draft_state = ''editing''' then
      raise exception 'freeze_invoice_preview change-draft marker missing';
    end if;
    patched := regexp_replace(
      def,
      'and d\.kind = ''change''[[:space:]]+and d\.draft_state = ''editing''',
      replacement,
      'g'
    );
    execute patched;
  end if;

  select pg_get_functiondef(
    'commercial.issue_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)'::regprocedure
  ) into def;
  def := regexp_replace(def, '^CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  if position('change_draft_is_invoice_blocker' in def) = 0 then
    if def !~ 'and d\.kind = ''change''[[:space:]]+and d\.draft_state = ''editing''' then
      raise exception 'issue_invoice change-draft marker missing';
    end if;
    patched := regexp_replace(
      def,
      'and d\.kind = ''change''[[:space:]]+and d\.draft_state = ''editing''',
      replacement,
      'g'
    );
    execute patched;
  end if;
end;
$patch$;

reset role;
