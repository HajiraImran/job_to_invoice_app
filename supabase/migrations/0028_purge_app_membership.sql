-- Purge runtime login membership.
-- The migration/runtime login may SET LOCAL ROLE purge_app.
-- Privileges are not inherited, and the grant has no ADMIN option.
-- purge_app stays NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION.
-- Repeating this grant keeps the same membership and refreshes those options.

grant purge_app to current_user with inherit false, set true, admin false;
