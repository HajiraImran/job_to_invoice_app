-- Worker runtime login membership (ARC02 / D-010).
-- Mirrors 0001 `grant api_app to current_user` so SET LOCAL ROLE worker_app
-- succeeds for the same migration/runtime login. Does not ALTER ROLE.
-- worker_app stays NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION.
-- All worker operations still use transaction-local SET LOCAL ROLE worker_app.
-- GRANT is idempotent under ordinary PostgreSQL membership semantics.

grant worker_app to current_user;
