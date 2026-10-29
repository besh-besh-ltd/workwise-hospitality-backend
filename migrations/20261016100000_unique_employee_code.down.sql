-- Reverses 20261016100000_unique_employee_code.sql.
--
-- Dropping the index lets duplicate codes be written again by scripts and bulk
-- loads. The application still refuses them on create and edit, and login
-- still refuses to guess between two active accounts, so nothing breaks — the
-- guarantee just moves back from the database to the code.

BEGIN;

DROP INDEX IF EXISTS public.uq_users_employee_code_live;

COMMIT;
