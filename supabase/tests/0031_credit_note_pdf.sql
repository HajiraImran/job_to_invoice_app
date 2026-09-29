-- Credit notes share original_pdf_download with quotes, invoices, and changes.

select
  has_function_privilege('api_app', 'commercial.original_pdf_download(uuid, uuid)', 'execute')
  and pg_get_functiondef('commercial.original_pdf_download(uuid, uuid)'::regprocedure)
    like '%''quote'', ''invoice'', ''credit'', ''change''%'
  and pg_get_functiondef('commercial.complete_original_pdf(uuid, uuid, text, text, bigint)'::regprocedure)
    like '%credit-original-v1%'
  as ok;
