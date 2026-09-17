-- Customer portal OTP, TX02, and revision supersession privileges (D-018).

select
  has_function_privilege('api_app', 'commercial.exchange_approval_token(text, text)', 'execute')
  and has_function_privilege('api_app', 'commercial.send_portal_code(text, text, integer, bytea, text, integer, bytea, bytea)', 'execute')
  and has_function_privilege('api_app', 'commercial.verify_portal_code(text, text)', 'execute')
  and has_function_privilege('api_app', 'commercial.get_portal_document(text)', 'execute')
  and has_function_privilege(
    'api_app',
    'commercial.decide_portal_quote(text, uuid, text, text, text, text, boolean, text, text, jsonb, integer, bytea, text, integer, bytea, bytea, bytea, text, integer, bytea, bytea)',
    'execute'
  )
  and has_function_privilege(
    'api_app',
    'commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid)',
    'execute'
  )
  and has_function_privilege('api_app', 'identity.set_local_portal_context(uuid, uuid)', 'execute')
  and has_function_privilege('api_app', 'commercial.expire_due_job_approvals(uuid, uuid)', 'execute')
  and has_function_privilege('api_app', 'commercial.owner_job_request(uuid, uuid)', 'execute')
  and has_function_privilege('worker_app', 'commercial.claim_send_email()', 'execute')
  and not has_function_privilege('api_app', 'commercial.claim_send_email()', 'execute')
  and not has_function_privilege('worker_app', 'commercial.exchange_approval_token(text, text)', 'execute')
  and not has_function_privilege('anon', 'commercial.decide_portal_quote(text, uuid, text, text, text, text, boolean, text, text, jsonb, integer, bytea, text, integer, bytea, bytea, bytea, text, integer, bytea, bytea)', 'execute')
  and not has_table_privilege('api_app', 'commercial.approval_challenges', 'select')
  and not has_table_privilege('api_app', 'commercial.approval_sessions', 'select')
  and not has_table_privilege('worker_app', 'commercial.approval_decisions', 'select')
  and not has_table_privilege('anon', 'commercial.scope_entries', 'select')
  and exists (
    select 1 from pg_constraint
    where conrelid = 'commercial.delivery_attempts'::regclass
      and conname = 'delivery_attempts_template_check'
  )
  as ok;
