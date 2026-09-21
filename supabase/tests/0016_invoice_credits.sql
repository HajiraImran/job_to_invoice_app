-- Credit allocations, EMAIL07, credit-aware ledger grants, and RESET ROLE (S18 / BIL04).

select
  has_function_privilege(
    'api_app',
    'commercial.freeze_credit_preview(uuid, uuid, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.issue_credit(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'worker_app',
    'commercial.credit_email_facts(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.issue_credit(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.freeze_credit_preview(uuid, uuid, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_table_privilege('api_app', 'commercial.credit_allocations', 'select')
  and not has_table_privilege('api_app', 'commercial.credit_allocations', 'insert')
  and exists (
    select 1 from pg_indexes
    where schemaname = 'commercial' and indexname = 'credit_allocations_credit_line'
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'commercial' and indexname = 'document_drafts_one_editing_credit'
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'commercial.delivery_attempts'::regclass
      and conname = 'delivery_attempts_template_check'
      and pg_get_constraintdef(oid) like '%EMAIL07%'
  )
  and exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'commercial'
      and c.relname = 'credit_allocations'
      and c.relrowsecurity
      and c.relforcerowsecurity
  )
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
