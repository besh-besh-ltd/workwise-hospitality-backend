-- Recreate the two dead ledgers, empty, exactly as they were.

CREATE TABLE IF NOT EXISTS public.migrations (
  id     serial PRIMARY KEY,
  name   varchar(255)                NOT NULL,
  run_on timestamp without time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS public.tbl_migrations (
  id           serial PRIMARY KEY,
  file_name    text                        NOT NULL,
  checksum     text                        NOT NULL,
  started_at   timestamp without time zone NOT NULL,
  completed_at timestamp without time zone,
  status       varchar(20)                 NOT NULL,
  error        text,
  reverted_at  timestamp without time zone,
  UNIQUE (file_name, checksum)
);
