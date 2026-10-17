-- Add copied_from_rfq_id to tbl_rfq for RFQ Copy lineage tracking.
--
-- The RFQ Copy feature (RFQ Management → Copy action) creates a fresh DRAFT RFQ
-- pre-populated from a source RFQ. This column records the source so the
-- frontend can render a back-link ("Copied from RFQ #N") on the new RFQ's
-- detail page, and a forward-link ("Copies of this RFQ") on the source.
--
-- Self-referencing FK with ON DELETE SET NULL so deleting a source RFQ doesn't
-- block deletes or orphan the copies — copies survive with a null pointer.
--
-- Partial index keeps lookups for forward-link queries
-- (WHERE copied_from_rfq_id = $1) fast without bloating the index with NULLs,
-- since the overwhelming majority of RFQs are NOT copies.

ALTER TABLE tbl_rfq
  ADD COLUMN IF NOT EXISTS copied_from_rfq_id INTEGER NULL;

-- Denormalized copy of the source RFQ's rfq_no so list endpoints can render
-- "Copied from RFQ #N" without a per-row subquery. rfq_no never changes after
-- creation, so this is safe to denormalize.
ALTER TABLE tbl_rfq
  ADD COLUMN IF NOT EXISTS copied_from_rfq_no INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tbl_rfq_copied_from_rfq_id_fkey'
  ) THEN
    ALTER TABLE tbl_rfq
      ADD CONSTRAINT tbl_rfq_copied_from_rfq_id_fkey
      FOREIGN KEY (copied_from_rfq_id) REFERENCES tbl_rfq(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tbl_rfq_copied_from_rfq_id
  ON tbl_rfq (copied_from_rfq_id)
  WHERE copied_from_rfq_id IS NOT NULL;

-- Backfill copied_from_rfq_no for any rows that were created between the first
-- and second versions of this migration (idempotent — re-running is a no-op).
UPDATE tbl_rfq target
SET copied_from_rfq_no = src.rfq_no
FROM tbl_rfq src
WHERE target.copied_from_rfq_id IS NOT NULL
  AND target.copied_from_rfq_no IS NULL
  AND src.id = target.copied_from_rfq_id;
