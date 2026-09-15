-- Original quote PDF worker functions are worker_app EXECUTE only.
-- API reads download state through original_pdf_download. No worker table DML.

select
  has_function_privilege('worker_app', 'commercial.claim_generate_original_pdf()', 'execute')
  and has_function_privilege('worker_app', 'commercial.heartbeat_outbox_task(uuid)', 'execute')
  and has_function_privilege('worker_app', 'commercial.reserve_original_pdf_artifact(uuid)', 'execute')
  and has_function_privilege('worker_app', 'commercial.load_original_pdf_source(uuid)', 'execute')
  and has_function_privilege(
    'worker_app',
    'commercial.complete_original_pdf(uuid, uuid, text, text, bigint)',
    'execute'
  )
  and has_function_privilege('worker_app', 'commercial.fail_original_pdf(uuid, text, boolean)', 'execute')
  and has_function_privilege('api_app', 'commercial.original_pdf_download(uuid, uuid)', 'execute')
  and not has_function_privilege('api_app', 'commercial.claim_generate_original_pdf()', 'execute')
  and not has_function_privilege('anon', 'commercial.claim_generate_original_pdf()', 'execute')
  and not has_function_privilege('authenticated', 'commercial.complete_original_pdf(uuid, uuid, text, text, bigint)', 'execute')
  and not has_function_privilege('worker_app', 'commercial.original_pdf_download(uuid, uuid)', 'execute')
  and not has_table_privilege('worker_app', 'commercial.outbox_tasks', 'select')
  and not has_table_privilege('worker_app', 'commercial.artifacts', 'insert')
  and not has_table_privilege('worker_app', 'commercial.documents', 'select')
  and not has_table_privilege('api_app', 'commercial.outbox_tasks', 'select')
  and commercial.retry_delay_for_attempt(1) = interval '30 seconds'
  and commercial.retry_delay_for_attempt(2) = interval '2 minutes'
  and commercial.retry_delay_for_attempt(3) = interval '10 minutes'
  and commercial.retry_delay_for_attempt(4) = interval '30 minutes'
  and commercial.retry_delay_for_attempt(5) = interval '30 minutes'
  as ok;
