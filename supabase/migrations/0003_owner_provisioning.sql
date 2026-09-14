-- Owner provisioning after verified Auth JWT. Jobs/quotes/approvals/invoices remain later.

set role migrator;

alter table identity.app_users
  add column analytics_alias_id uuid not null default gen_random_uuid();

alter table identity.app_users
  add constraint app_users_analytics_alias_id_key unique (analytics_alias_id);

alter table commercial.workspaces
  add column setup_completed_at timestamptz;

create table commercial.analytics_events (
  workspace_id uuid not null,
  id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_id uuid not null,
  event_name text not null,
  schema_version integer not null default 1,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  pseudonymous_owner_id uuid not null,
  job_id uuid,
  safe_properties_json jsonb not null default '{}'::jsonb,
  constraint analytics_events_pkey primary key (id),
  constraint analytics_events_tenant_id_key unique (workspace_id, id),
  constraint analytics_events_event_id_key unique (event_id),
  constraint analytics_events_workspace_fk
    foreign key (workspace_id) references commercial.workspaces (workspace_id) on delete restrict,
  constraint analytics_events_schema_version_check check (schema_version >= 1)
);

create unique index analytics_events_signup_verified_once
  on commercial.analytics_events (workspace_id)
  where event_name = 'signup_verified';

alter table commercial.analytics_events enable row level security;
alter table commercial.analytics_events force row level security;
select identity.install_migrator_force_rls_policy('commercial.analytics_events');

create policy analytics_events_select on commercial.analytics_events
  for select to api_app
  using (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = analytics_events.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create policy analytics_events_insert on commercial.analytics_events
  for insert to api_app
  with check (
    workspace_id = identity.current_workspace_id()
    and exists (
      select 1 from commercial.memberships m
      where m.workspace_id = analytics_events.workspace_id
        and m.user_id = identity.current_actor_id()
        and m.status = 'active'
    )
  );

create or replace function identity.provision_owner(
  p_auth_user_id uuid,
  p_display_email text,
  p_normalized_email text
)
returns table (
  actor_id uuid,
  workspace_id uuid,
  account_status text,
  display_email text,
  setup_completed boolean,
  first_sign_in boolean,
  analytics_alias_id uuid
)
language plpgsql
security definer
set search_path = identity, commercial, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid;
  v_ws uuid;
  v_status text;
  v_email text;
  v_alias uuid;
  v_setup boolean;
  v_first boolean := false;
begin
  if p_auth_user_id is null or p_display_email is null or p_normalized_email is null then
    raise exception 'invalid identity' using errcode = '22023';
  end if;

  select u.id, u.status, u.display_email, u.analytics_alias_id
    into v_actor, v_status, v_email, v_alias
  from identity.app_users u
  where u.auth_user_id = p_auth_user_id
  for update;

  if v_actor is null then
    begin
      v_actor := gen_random_uuid();
      v_alias := gen_random_uuid();
      insert into identity.app_users (
        id, auth_user_id, normalized_email, display_email, status,
        last_authenticated_at, terms_version, privacy_version, analytics_alias_id
      ) values (
        v_actor, p_auth_user_id, p_normalized_email, p_display_email, 'active',
        now(), '1', '1', v_alias
      );
      v_status := 'active';
      v_email := p_display_email;
      v_first := true;
    exception
      when unique_violation then
        select u.id, u.status, u.display_email, u.analytics_alias_id
          into v_actor, v_status, v_email, v_alias
        from identity.app_users u
        where u.auth_user_id = p_auth_user_id;
        if v_actor is null then
          raise;
        end if;
        v_first := false;
        update identity.app_users
          set last_authenticated_at = now()
          where id = v_actor;
    end;
  else
    update identity.app_users
      set last_authenticated_at = now(),
          display_email = case when status = 'active' then p_display_email else display_email end,
          normalized_email = case when status = 'active' then p_normalized_email else normalized_email end
      where id = v_actor
      returning status, display_email, analytics_alias_id
        into v_status, v_email, v_alias;
  end if;

  select w.id, (w.setup_completed_at is not null)
    into v_ws, v_setup
  from commercial.workspaces w
  where w.owner_user_id = v_actor
  for update;

  if v_ws is null then
    begin
      v_ws := gen_random_uuid();
      insert into commercial.workspaces (
        workspace_id, id, owner_user_id, business_name, legal_name, contact_name,
        contact_email, timezone, trade, default_terms, setup_completed_at
      ) values (
        v_ws, v_ws, v_actor, '', '', '', p_display_email, 'UTC', 'other', '', null
      );
      insert into commercial.memberships (workspace_id, id, user_id, role, status)
      values (v_ws, gen_random_uuid(), v_actor, 'owner', 'active');
      v_setup := false;
    exception
      when unique_violation then
        select w.id, (w.setup_completed_at is not null)
          into v_ws, v_setup
        from commercial.workspaces w
        where w.owner_user_id = v_actor;
        if v_ws is null then
          raise;
        end if;
    end;
  end if;

  if v_first and v_status = 'active' then
    begin
      insert into commercial.analytics_events (
        workspace_id, event_id, event_name, schema_version, occurred_at,
        pseudonymous_owner_id, safe_properties_json
      )
      values (
        v_ws, gen_random_uuid(), 'signup_verified', 1, now(), v_alias,
        jsonb_build_object('acquisition_source', 'unknown')
      );
    exception
      when unique_violation then
        null;
    end;
  end if;

  return query
    select v_actor, v_ws, v_status, v_email, coalesce(v_setup, false), v_first, v_alias;
end;
$$;

comment on function identity.provision_owner(uuid, text, text) is
  'Maps a verified Auth subject to app identity and one workspace. Callers must not pass workspace_id.';

revoke all on function identity.provision_owner(uuid, text, text) from public;
grant execute on function identity.provision_owner(uuid, text, text) to api_app;

grant select, insert on commercial.analytics_events to api_app;
revoke all on commercial.analytics_events from public, anon, authenticated, worker_app, purge_app;

reset role;
