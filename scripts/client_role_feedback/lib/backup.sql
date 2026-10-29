-- ═══════════════════════════════════════════════════════════════════════════
-- Backup helpers (session-temporary functions; they die with the psql session).
--
-- Every write step copies the rows it is about to change into
--   ops_backup._bak_<step>_<request_short>
-- as before-images, and the same rows as after-images once it has changed
-- them. The 99_rollback_<step>.sql scripts restore the before-images, and
-- refuse when the live rows no longer equal the after-images (somebody changed
-- them since; a human decides).
--
-- One table per run: (src_table, row_id, phase) → row_data jsonb (to_jsonb of
-- the full row). CREATE TABLE without IF NOT EXISTS, so a reused request id
-- fails instead of mixing two runs. A DRY run creates it and rolls it back.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE FUNCTION pg_temp.bak_name(p_step text, p_short text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT format('ops_backup.%I', '_bak_' || p_step || '_' || p_short)
$f$;

CREATE FUNCTION pg_temp.bak_create(p_step text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE
  t   text;
  prm record;
BEGIN
  SELECT * INTO STRICT prm FROM _params;
  t := pg_temp.bak_name(p_step, prm.request_short);
  CREATE SCHEMA IF NOT EXISTS ops_backup;
  EXECUTE format($ddl$
    CREATE TABLE %s (
      request_id   uuid        NOT NULL,
      step         text        NOT NULL,
      src_table    text        NOT NULL,
      row_id       integer     NOT NULL,
      phase        text        NOT NULL CHECK (phase IN ('before', 'after')),
      row_data     jsonb       NOT NULL,
      backed_up_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (src_table, row_id, phase)
    )$ddl$, t);
  EXECUTE format('COMMENT ON TABLE %s IS %L', t,
    format('client_role_feedback step %s, request %s, actor %s: before/after images. Restore with 99_rollback_%s.sql -v rollback_request_id=%s',
           p_step, prm.request_id, prm.actor_id, p_step, prm.request_id));
  RAISE NOTICE 'backup table %', t;
  RETURN t;
END $f$;

-- Copy the given rows of a public table into this run's backup table.
CREATE FUNCTION pg_temp.bak_put(p_step text, p_src text, p_phase text, p_ids int[]) RETURNS integer
LANGUAGE plpgsql AS $f$
DECLARE
  t   text;
  n   integer;
  prm record;
BEGIN
  SELECT * INTO STRICT prm FROM _params;
  t := pg_temp.bak_name(p_step, prm.request_short);
  EXECUTE format(
    'INSERT INTO %s (request_id, step, src_table, row_id, phase, row_data)
     SELECT $1, $2, $3, x.id, $4, to_jsonb(x) FROM public.%I x WHERE x.id = ANY ($5)',
    t, p_src)
  USING prm.request_id, p_step, p_src, p_phase, p_ids;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> COALESCE(cardinality(p_ids), 0) THEN
    RAISE EXCEPTION 'backup %: expected % % row(s) for %, copied %', t, cardinality(p_ids), p_src, p_phase, n;
  END IF;
  RETURN n;
END $f$;

-- Rollback side: load the backup of the run being undone into _bak.
CREATE FUNCTION pg_temp.bak_load(p_step text) RETURNS integer
LANGUAGE plpgsql AS $f$
DECLARE
  t   text;
  n   integer;
  prm record;
BEGIN
  SELECT * INTO STRICT prm FROM _params;
  IF prm.rollback_request_id IS NULL THEN
    RAISE EXCEPTION 'rollback needs the request id of the run to undo: -v rollback_request_id=<uuid>';
  END IF;
  t := pg_temp.bak_name(p_step, prm.rollback_short);
  IF to_regclass(t) IS NULL THEN
    RAISE EXCEPTION 'no backup table % — wrong request id, or that run was DRY (nothing to undo)', t;
  END IF;
  EXECUTE format('CREATE TEMP TABLE _bak AS SELECT * FROM %s', t);
  IF EXISTS (SELECT 1 FROM _bak WHERE request_id <> prm.rollback_request_id OR step <> p_step) THEN
    RAISE EXCEPTION 'backup % holds rows of another run or step — refusing', t;
  END IF;
  SELECT count(*) INTO n FROM _bak;
  IF n = 0 THEN
    RAISE EXCEPTION 'backup % is empty', t;
  END IF;
  RAISE NOTICE 'restoring from % (% image row(s))', t, n;
  RETURN n;
END $f$;
