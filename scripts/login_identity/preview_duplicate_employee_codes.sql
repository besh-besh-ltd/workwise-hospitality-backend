-- Read-only. What repair_duplicate_employee_codes.sql would change, and what
-- would still block migration 20261016100000_unique_employee_code.
--
--   psql "$PROD" -v ON_ERROR_STOP=1 -f scripts/login_identity/preview_duplicate_employee_codes.sql

BEGIN READ ONLY;

-- Every code shared by more than one live account (the migration's own test).
SELECT upper(btrim(u.employee_code)) AS code,
       u.id, u.status, u.company_id, u.created_at, u.updated_at,
       (SELECT max(l.date) FROM public.tbl_login_log l WHERE l.user_id = u.id) AS last_login,
       CASE
         WHEN u.id IN (330, 135, 144) THEN btrim(u.employee_code) || '-INACTIVE-' || u.id
         WHEN u.id = 617 THEN 'AWS2'
         ELSE '(unchanged)'
       END AS after_repair
  FROM public.tbl_users u
 WHERE u.is_deleted = 0 AND u.user_type <> 1
   AND u.employee_code IS NOT NULL AND btrim(u.employee_code) <> ''
   AND upper(btrim(u.employee_code)) IN (
         SELECT upper(btrim(employee_code))
           FROM public.tbl_users
          WHERE is_deleted = 0 AND user_type <> 1
            AND employee_code IS NOT NULL AND btrim(employee_code) <> ''
          GROUP BY 1 HAVING count(*) > 1)
 ORDER BY 1, u.id;

-- Codes stored with surrounding whitespace.
SELECT id, '"' || employee_code || '"' AS stored, btrim(employee_code) AS after_repair
  FROM public.tbl_users
 WHERE employee_code <> btrim(employee_code);

ROLLBACK;
