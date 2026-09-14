-- Authorization invariants that can be asserted as the bootstrap role.

select
  bool_and(c.relrowsecurity and c.relforcerowsecurity) as force_rls,
  bool_and(pg_get_userbyid(c.relowner) = 'migrator') as owned_by_migrator
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('identity', 'commercial')
  and c.relkind = 'r';
