-- Authorization invariants that can be asserted as the bootstrap role.

select
  bool_and(c.relrowsecurity and c.relforcerowsecurity) as force_rls,
  bool_and(pg_get_userbyid(c.relowner) = 'migrator') as owned_by_migrator,
  bool_and(exists (
    select 1
    from pg_policy p
    where p.polrelid = c.oid
      and p.polname = n.nspname || '_' || c.relname || '_migrator_all'
      and p.polcmd = '*'
  )) as migrator_policy
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('identity', 'commercial')
  and c.relkind = 'r';
