-- Foundation assertion: private schema exists. Product RLS tests arrive with Stage 1 tables.

select 1
from information_schema.schemata
where schema_name = 'commercial';
