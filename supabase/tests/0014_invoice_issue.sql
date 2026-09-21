-- Invoice issue grants, uniqueness, EMAIL06, and RESET ROLE (TX03).

select
  has_function_privilege(
    'api_app',
    'commercial.freeze_invoice_preview(uuid, uuid, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.issue_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.issue_invoice(uuid, uuid, text, uuid, uuid, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.freeze_invoice_preview(uuid, uuid, text, bytea, jsonb, timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.approved_quote_recipient(uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'worker_app',
    'commercial.approved_quote_recipient(uuid, uuid)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.document_delivery_status(uuid, uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'commercial.document_delivery_status(uuid, uuid)',
    'execute'
  )
  and has_function_privilege('worker_app', 'commercial.invoice_email_facts(uuid)', 'execute')
  and not has_function_privilege('api_app', 'commercial.invoice_email_facts(uuid)', 'execute')
  and exists (
    select 1 from pg_constraint
    where conrelid = 'commercial.jobs'::regclass
      and conname = 'jobs_active_invoice_fk'
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'commercial'
      and indexname = 'documents_one_active_invoice'
  )
  and exists (
    select 1 from pg_constraint
    where conrelid = 'commercial.delivery_attempts'::regclass
      and conname = 'delivery_attempts_template_check'
  )
  and has_table_privilege('api_app', 'commercial.scope_entries', 'select')
  and not has_table_privilege('api_app', 'commercial.scope_entries', 'insert')
  and current_user not in ('api_app', 'worker_app', 'purge_app', 'anon', 'authenticated')
  as ok;
