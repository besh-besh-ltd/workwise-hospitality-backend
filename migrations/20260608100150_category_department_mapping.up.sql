-- ARC v2 — Migration 3 of 10: category ↔ department mapping.
--
-- ARC v2 creation is category-driven (PRD §7.1). When the creator picks a
-- category, the wizard must show only the departments allowed to procure
-- that category — filtered further by the user's permission scope.
--
-- This M:N table is the single source of truth. It also drives MR scoping
-- (PRD §7.8): an MR raiser in dept X sees items only from categories that
-- map to dept X.
--
-- Per plan §4.9, we first check whether a comparable mapping table exists
-- under another name. None was found via a `grep -i category.*department`
-- sweep of tests/setup/schema.sql, so this CREATE is safe.
--
-- Seeding is intentionally NOT done here — tenant admins maintain the
-- mapping via a small new admin UI added in the same phase. The pilot can
-- run inserts manually post-deploy.

CREATE TABLE IF NOT EXISTS public.tbl_category_department (
  id            BIGSERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES public.tbl_category(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES public.tbl_department(id) ON DELETE CASCADE,
  created_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tbl_category_department_uniq UNIQUE (category_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_tbl_category_department_category
  ON public.tbl_category_department (category_id);
CREATE INDEX IF NOT EXISTS idx_tbl_category_department_department
  ON public.tbl_category_department (department_id);
