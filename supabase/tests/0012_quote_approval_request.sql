-- Quote approval-request delivery privileges (D-017).

select
  has_function_privilege(
    'api_app',
    'commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid)',
    'execute'
  )
  and has_function_privilege('api_app', 'commercial.owner_job_request(uuid, uuid)', 'execute')
  and has_function_privilege('api_app', 'commercial.apply_resend_email_event(text, text, text)', 'execute')
  and has_function_privilege('worker_app', 'commercial.claim_send_email()', 'execute')
  and has_function_privilege('worker_app', 'commercial.complete_send_email(uuid, text)', 'execute')
  and has_function_privilege('worker_app', 'commercial.fail_send_email(uuid, text, boolean)', 'execute')
  and has_function_privilege('purge_app', 'commercial.purge_expired_delivery_payloads()', 'execute')
  and not has_function_privilege('api_app', 'commercial.claim_send_email()', 'execute')
  and not has_function_privilege('worker_app', 'commercial.apply_resend_email_event(text, text, text)', 'execute')
  and not has_function_privilege('worker_app', 'commercial.owner_job_request(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'commercial.claim_send_email()', 'execute')
  and not has_function_privilege('authenticated', 'commercial.publish_quote_draft(uuid, uuid, text, uuid, uuid, integer, text, text, text, text, integer, bytea, bytea, bytea, text, integer, timestamptz, timestamptz, uuid)', 'execute')
  and not has_table_privilege('api_app', 'commercial.encrypted_delivery_payloads', 'select')
  and not has_table_privilege('worker_app', 'commercial.encrypted_delivery_payloads', 'select')
  and not has_table_privilege('worker_app', 'commercial.approval_requests', 'select')
  and not has_table_privilege('api_app', 'commercial.provider_events', 'select')
  and not has_table_privilege('anon', 'commercial.approval_requests', 'select')
  and commercial.email_retry_delay_for_attempt(1) = interval '1 minute'
  and commercial.email_retry_delay_for_attempt(2) = interval '5 minutes'
  and commercial.email_retry_delay_for_attempt(3) = interval '30 minutes'
  and commercial.email_retry_delay_for_attempt(4) = interval '2 hours'
  and commercial.email_retry_delay_for_attempt(5) = interval '8 hours'
  and exists (
    select 1 from pg_indexes
    where schemaname = 'commercial'
      and indexname = 'approval_requests_pending_approval_key'
  )
  as ok;
