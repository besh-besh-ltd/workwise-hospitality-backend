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
npm run migrate:status            # what is applied, what is pending
npm run migrate:up                # apply pending
npm run migrate:down -- --count 1 # revert the last migration (see "Rolling back")
npm run migrate:verify            # exit non-zero if anything is pending
```

**`up` and `down` refuse a remote database unless you say so.** `backend/.env` points at
**staging** (`hospitality_stage` on RDS), not at a local database — so an unguarded
`npm run migrate:up` from a plain terminal would write to a shared environment. Against
anything other than `localhost`/`127.0.0.1`/`::1` these two commands make you type the
database name at a prompt, or pass `--yes` when there is no terminal. The deploy workflows
pass `--yes` deliberately. `status`, `verify` and `manifest` are read-only and ungated.

**`down` asks for more.** On a remote target it also requires `--confirm <database>`
naming the resolved target, because it executes `.down.sql` files and some of those
drop tables. `--yes` alone is not enough — it is a flag you could copy out of a
workflow file without meaning to.

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

Reverting a deploy's *code* needs no database change at all, which is what the
expand-then-contract rule buys you: `workflow_dispatch` the deploy workflow with an
older `commit_sha` and leave the schema alone.

If the schema genuinely has to be reverted, **`migrate:down` is the supported path**.
It runs the `.down.sql` files and removes the ledger rows in one step, in the runner's
own transaction, so the database and the ledger cannot end up disagreeing:

```bash
# Back the database up first. On a remote target both flags are required.
npm run migrate:down -- --count 1 --yes --confirm hospitality_main
npm run migrate:status
```

`--count` defaults to 1 and reverts the *most recently applied* migrations, newest
first. There is no upper bound on it, so pick the number deliberately.

Running the `.down.sql` by hand is the break-glass option, for when the down file
itself is broken and needs editing before it will execute. If you do that, you own
what the runner would otherwise have handled: back the database up first, and delete
the matching `pgmigrations` row yourself — leave it behind and `migrate:status`
reports the migration as still applied, so the next deploy will not re-apply it.

## Troubleshooting

### `Not run migration X is preceding already run migration Y`

Every `migrate:up` fails, on staging or production, and nothing you can revert in git
fixes it. `checkOrder` compares the migration filenames on disk against the ledger
positionally, and something has made those two orders disagree. There are two causes.

**Two PRs merged out of timestamp order.** Gate 2 compares each PR against the base
branch *at PR time*, so two PRs opened from the same base both pass individually and
only conflict once both are merged. Fix: re-stamp the newer migration's filename —
rename both halves to a timestamp above everything already merged, in a new PR. It has
not run anywhere yet, so renaming it is free.

Enabling **"Require branches to be up to date before merging"** on `main` and `qa`
prevents this class entirely: the second PR must rebase onto the first, and gate 2
then sees the timestamp it is actually competing with.

**A merged migration was renamed.** The ledger keeps the old name while `migrations/`
now offers the new one. Gate 4 rejects this now, but a branch cut before that gate
landed can still carry one. Fix: rename it back to exactly the name in `pgmigrations`
(`npm run migrate:status` prints what the ledger holds). If the name really is wrong,
leave it and write a *new* migration — a merged filename is as immutable as its
contents.

Hand-editing `pgmigrations` to match the new name also works and is a last resort:
it silently makes the two databases disagree about their own history if you only
remember to do it on one of them.
