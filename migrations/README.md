# Database migrations

Applied by `node-pg-migrate`, tracked in the `pgmigrations` table, run
automatically on merge — staging unattended, production behind one approval click.

## Writing one

```bash
TS=$(date -u +%Y%m%d%H%M%S)
touch "migrations/${TS}_short_slug.up.sql" "migrations/${TS}_short_slug.down.sql"
```

Filenames must be `YYYYMMDDHHMMSS_lower_snake_slug.up.sql` and `.down.sql`. CI
rejects anything else.

**Every up migration needs a down migration.** CI replays yours down and back up,
so a down file that does not execute fails the PR. If a change genuinely cannot be
reversed — a destructive data backfill — put `-- irreversible: <reason>` in the up
file and omit the down.

**Do not write `BEGIN;` or `COMMIT;`.** The runner wraps each migration in its own
transaction. A statement-level `BEGIN` inside that wrapper warns, and the matching
`COMMIT` closes the *outer* transaction early — the migration keeps running with no
rollback behind it. CI rejects these.

## The two rules that matter

**Expand, then contract.** Migrations run *before* the new code deploys, and if a
migration fails the deploy is skipped and the *old* code keeps serving. So every
migration must be backward-compatible with the code currently in production. Add
columns, backfill, and ship the code that uses them. Drop the old column in a
*later* PR, once nothing references it.

**Add an enum label in one migration, use it in the next.** PostgreSQL permits
`ALTER TYPE … ADD VALUE` inside a transaction but forbids *using* the new value
until that transaction commits. Plain `.sql` migrations cannot opt out of the
wrapper, so the label and its first use must be two separate migrations.

## Commands

```bash
npm run migrate:status     # what is applied, what is pending
npm run migrate:up         # apply pending
npm run migrate:verify     # exit non-zero if anything is pending
```

**`up` and `down` refuse a remote database unless you say so.** `backend/.env` points at
**staging** (`hospitality_stage` on RDS), not at a local database — so an unguarded
`npm run migrate:up` from a plain terminal would write to a shared environment. Against
anything other than `localhost`/`127.0.0.1`/`::1` these two commands make you type the
database name at a prompt, or pass `--yes` when there is no terminal. The deploy workflows
pass `--yes` deliberately. `status`, `verify` and `manifest` are read-only and ungated.

To point at a local database, override the whole target rather than relying on `.env`:

```bash
HOST=localhost DATABASE_USERNAME="$USER" DATABASE_PASSWORD= \
  DATABASE_NAME=my_scratch_db TEST_DB_NO_SSL=1 npm run migrate:status
```

## Reproducing the CI replay locally

`npm run migrate:replay` **does not replay.** It rebuilds the scratch database —
drops and recreates it, restores `baseline/production_baseline.sql`, then seeds
`baseline/MANIFEST.txt` into `pgmigrations` — and stops there. `migrate:up` is what
performs the replay, onto that floor.

It also refuses any database not named `migration_replay[_suffix]`, because it drops
its target. `backend/.env` names `hospitality_stage`, so a bare `npm run migrate:replay`
aborts at that guard. Export the whole target first — this is the same invocation CI
runs, and the one the `CI gate` job prints when the replay fails:

```bash
export HOST=localhost DATABASE_PORT=5432 DATABASE_USERNAME="$USER" DATABASE_PASSWORD= \
       DATABASE_NAME=migration_replay TEST_DB_NO_SSL=1 REPLAY_MAINTENANCE_DB=postgres PGOPTIONS='-c timezone=UTC'
npm run migrate:replay && npm run migrate:up && npm run migrate:verify
```

Use `export`, not an env prefix before `&&` — a prefix applies only to the first
command in the chain, so `migrate:up` would fall through to `.env`, find staging, and
hit the REMOTE-target guard instead of touching `migration_replay`. Swap
`DATABASE_USERNAME`/`DATABASE_PASSWORD` for your own Postgres superuser if you are not
on a trust-auth Homebrew install. Drop the scratch database when you are done:
`dropdb migration_replay`.

`npm run migrate:baseline` marks migrations applied *without running them*. It
exists for adopting a database that already has the schema, it requires the target
database name typed back with `--confirm`, and it is never part of a workflow. If
you are reaching for it during normal work, something else is wrong.

## `baseline/`

The migrations here cannot rebuild the database — roughly 180 legacy tables predate
the first migration file and exist in no migration. `baseline/production_baseline.sql`
is a schema-only dump of production, and `baseline/MANIFEST.txt` lists the migrations
already applied in it. Together they are the floor that CI replays onto.

Re-baseline when the replay gets slow — roughly annually.

```bash
npm run migrate:dump-baseline -- --database hospitality_main
```

This dumps production's schema (read-only `pg_dump`) and regenerates
`MANIFEST.txt` **from that database's own `pgmigrations` ledger** — not from your
checkout. Production applies migrations behind a manual approval, so `main` is
routinely ahead of it; a manifest built from the working tree would claim
migrations the dump does not contain, CI would seed them as already applied, and
every later PR would replay onto a floor missing that schema. Nothing downstream
would notice, so the check has to be here.

It therefore refuses, writing nothing, when:

- the target has no `pgmigrations` table (a database with no ledger cannot be
  baselined *from*);
- the ledger and `migrations/` disagree — it prints both sides rather than
  picking a winner. Usually this means your checkout is ahead of production;
  check out the commit production is actually on;
- the dump looks like it came from staging. `--database` has no default, because
  staging and production live on the same RDS host.

Review the diff and commit both files. `scripts/dump-baseline.mjs` carries the
exclusion list, the ledger cross-check and the staging/production check, so
nothing about doing this correctly depends on anyone remembering a hand-typed
command.

## Rolling back production

Do not. Roll *forward* with a new migration.

If the schema genuinely has to be reverted, run the `.down.sql` by hand against a
database you have backed up first, and note that the ledger row must be removed
too. Reverting a deploy's *code* needs no database change, which is what the
expand-then-contract rule buys you: `workflow_dispatch` the deploy workflow with an
older `commit_sha` and leave the schema alone.
