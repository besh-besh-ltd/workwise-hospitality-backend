-- Reports module: the export ledger.
--
-- Two jobs in one table, and the second is the reason it is a table at all:
--
--   1. Queue. A report over the size threshold is built in the background and
--      stored to S3 rather than held open on the request — a full Approval
--      Audit Trail or Open PO register is not something to stream inside a
--      gateway timeout.
--   2. Audit. "Who pulled the vendor spend for FY26, and when?" is a question
--      an internal auditor will ask, and today nothing anywhere can answer it.
--      SYNC downloads are therefore recorded too, even though they carry no
--      job: the row is written when the request is served and is the record of
--      the disclosure, not of the work.
--
-- `filters` is stored as given so a row reproduces exactly what was pulled.
-- It never contains a company or hotel id supplied by the caller — scope is
-- derived from the user — so it is safe to replay.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_report_exports (
  id                       bigserial PRIMARY KEY,
  report_key               text        NOT NULL,
  requested_by             integer     NOT NULL REFERENCES public.tbl_users(id),
  hospitality_company_id   integer     NOT NULL,
  -- The scope actually applied, snapshotted. A user's mappings change; this
  -- keeps the row meaningful afterwards.
  hotel_ids                integer[]   NOT NULL DEFAULT '{}',
  filters                  jsonb       NOT NULL DEFAULT '{}',
  mode                     text        NOT NULL DEFAULT 'ASYNC'
                                       CHECK (mode IN ('SYNC', 'ASYNC')),
  status                   text        NOT NULL DEFAULT 'QUEUED'
                                       CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED')),
  row_count                integer,
  file_key                 text,
  file_size                bigint,
  error                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  started_at               timestamptz,
  completed_at             timestamptz,
  -- Generated files are transient; the ledger row is not. A reaper deletes the
  -- S3 object past this instant and leaves the row behind.
  expires_at               timestamptz
);

-- The "My exports" list.
CREATE INDEX IF NOT EXISTS idx_report_exports_requester
  ON public.tbl_report_exports (requested_by, created_at DESC);

-- The worker's claim query. Partial, because QUEUED/RUNNING is a handful of
-- rows against a table that only grows.
CREATE INDEX IF NOT EXISTS idx_report_exports_pending
  ON public.tbl_report_exports (created_at)
  WHERE status IN ('QUEUED', 'RUNNING');

-- The audit question: everything this company exported, newest first.
CREATE INDEX IF NOT EXISTS idx_report_exports_company
  ON public.tbl_report_exports (hospitality_company_id, created_at DESC);

COMMIT;
