# Postgres → MariaDB migration (parked)

**Status: parked, not merged.** This branch holds a complete, working, verified
migration from PostgreSQL to MariaDB 11.4. It was abandoned on 2026-08-01
because the original service and its original Postgres database were restored,
so the move was no longer necessary. Nothing here was ever run against the real
production site.

`main` is deliberately clean of all of this. If the migration is ever revived,
start from this branch rather than from scratch — everything below was measured
against a real production dump, not estimated.

The last pre-migration commit is tagged `pre-mariadb`.

---

## 1. Why this was needed

The replacement host (`eot.coderealms.io`, CloudLinux/cPanel shared hosting)
offered only MariaDB, no PostgreSQL and no Redis. The app leaned on four
Postgres-only features with no MariaDB equivalent:

- `ARRAY` columns (5 of them)
- `JSONB`
- the `@>` containment operator, via Sequelize's `Op.contains`
- the `citext` extension, for case-insensitive usernames and emails

## 2. What is on this branch

| Commit | Contents |
|---|---|
| `2506a105` | The migration: dialect swap, config layer, model types, `Op.contains` replacement, baseline migration, ETL script, tests, docker/CI config |
| `f74264e7` | Make Redis optional in production (the new host had no Redis) |

Key files:

| Path | Purpose |
|---|---|
| `src/server/sequelize.ts` | MariaDB dialect, timezone, charset, strict mode, pool |
| `src/server/util/environment.ts` | `databaseUrl()` / `databaseSsl()` / `databasePoolMax()` |
| `src/server/util/json_query.ts` | `jsonArrayContains()` — the `Op.contains` replacement |
| `src/migrations/20260801120000_mariadb_baseline.ts` | Entire schema in one migration |
| `src/scripts/pg_to_mariadb.ts` | Resumable ETL, with `--verify` and `--reset` |
| `src/server/mariadb_dbtest.ts` | 17 integration tests against a real MariaDB |
| `src/server/util/json_query_test.ts` | SQL-generation unit tests |
| `src/server/user/cache_test.ts` | In-memory user-cache fallback tests |

Environment variables changed: `POSTGRES_URL` and friends became
`DATABASE_URL` plus discrete `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` /
`DB_NAME` / `DB_SSL_CA` / `DB_SSL` / `DB_POOL_MAX`.

## 3. Verified state when parked

Everything below passed:

- 101 unit specs (`npm test`), 17 DB-integration specs (`npm run test-db`)
- `npm run lint` and full `npm run build` clean
- Full ETL of a production dump: 1,410,293 rows, all reconciliation checks exact
- Server boots under `NODE_ENV=production`, with and without `REDIS_URL`
- Game-list query verified against real data, 7–9 ms warm

## 4. Measured facts (from `dump.pgdump`, taken 2026-07-24, PG 18.3, db `aos`)

| Table | Rows | Uncompressed |
|---|---|---|
| GameHistories | 517,521 | 4.66 GB |
| Logs | 887,055 | 109 MB |
| Games | 3,024 | 24 MB |
| Feedbacks | 2,410 | 2.6 MB |
| Users | 1,283 | 0.3 MB |
| Invitations | 0 | — |

- Total source ≈ **4.79 GB uncompressed**. The 445 MB dump file is gzipped —
  do not plan capacity around that number.
- After load into MariaDB: **3.01 GB**, of which GameHistories is ~3.2 GB *with*
  `ROW_FORMAT=COMPRESSED`. Compression only bought ~31%, not the 3–4× hoped for.
- Largest values: `Games.gameData` 27,423 chars; `GameHistories.previousGameData`
  28,063 chars. Both uncomfortably close to the 64 KB `TEXT` ceiling, hence
  `MEDIUMTEXT`.
- Games is only ~3k rows, which is why `JSON_CONTAINS` full scans are fine and a
  normalized `GamePlayers` join table was **not** needed.
- **Production had zero foreign keys.** The baseline deliberately adds none.

Timings on an M-series laptop with Docker (expect 3–5× slower on shared hosting):

| Step | Time |
|---|---|
| `pg_restore` of the dump into local PG | 54 s |
| ETL Postgres → MariaDB | ~6 min (GameHistories ~3.7k rows/s, Logs ~59k rows/s) |
| `mariadb-dump` + gzip | ~4 min → 367 MB |
| Import of that dump into a fresh DB | 5 min 08 s |

## 5. Schema mapping

| Column(s) | Postgres | MariaDB |
|---|---|---|
| `Games.gameData`, `GameHistories.previousGameData` / `.patch` / `.actionData` | `text` | `MEDIUMTEXT` |
| `Games.{autoAction,config,variant,playerFlexTime}`, `Users.notificationPreferences` | `jsonb` | `JSON` |
| `Games.{playerIds,concedingPlayers,abandonedPlayerIds,notes}`, `Users.preferredColors` | `integer[]` / `text[]` / `smallint[]` | `JSON` (ordered) |
| `Users.{username,email}` | `citext` | `VARCHAR(255) COLLATE utf8mb4_uca1400_as_ci` |
| all timestamps | `timestamptz` | `DATETIME(3)`, model attribute `DataTypes.DATE(3)` |
| `Games.status` | native enum `enum_Games_status` | `VARCHAR(255)` (matches the model) |
| `Feedbacks.url` | `varchar(255)` | `TEXT` (aligned to the model) |
| `Games.autoStart` | `boolean NULL DEFAULT true` | `TINYINT(1) NOT NULL DEFAULT 1` |
| `Invitations` | table | dropped |

Array ordering is load-bearing: `GameDao.getNotesForUser` / `setNotesForUser`
index `notes` by position within `playerIds`.

## 6. Hard-won gotchas

These cost the most time to find. Read this section before touching anything.

1. **The connection URL scheme must be `mariadb://`.** `@sequelize/mariadb`'s
   `parseConnectionUrl` hardcodes `allowedProtocols: ["mariadb"]` and rejects
   `mysql://`. This alone forces the env-var rename.

2. **The driver rejects `utf8mb4_uca1400_*` as a `collation` connection
   option.** Its client-side collation table predates those names, so you get
   `Unknown collation`. Set it through `initSql` with
   `SET NAMES utf8mb4 COLLATE utf8mb4_uca1400_as_cs` instead. Passing only
   `charset: "utf8mb4"` silently yields `utf8mb4_uca1400_ai_ci`, which is
   accent-**in**sensitive and would quietly change login matching.

3. **MariaDB has no distinct JSON type.** `JSON` is an alias for
   `longtext` + `CHECK (json_valid(...))`, and `information_schema` reports
   `longtext`. Any test asserting a column's type is `json` will fail against
   correct code. Parsing is driven by the *model attribute type*, not the column
   type, so the meaningful guard is a round-trip test — see
   `src/server/mariadb_dbtest.ts`.

4. **MariaDB has no `CAST(x AS JSON)`.** Pass the candidate document as a
   string literal, e.g. `JSON_CONTAINS(col, '5')`.

5. **`DataTypes.DATE` truncates writes to whole seconds.** The mariadb dialect
   formats with `this.options.precision ?? 0`, so declaring `DATETIME(3)` in DDL
   is not enough — the model attribute must be `DataTypes.DATE(3)`.

6. **`timezone` must be a fixed offset, never a named zone.** Shared hosts
   usually leave `mysql.time_zone_name` empty, so `SET time_zone='America/...'`
   fails outright. Pinned to `+00:00`.

7. **`Op.contains` cannot work.** Sequelize compiles it to the literal Postgres
   `@>` operator (`where-sql-builder.js`). MariaDB also has no `MEMBER OF`
   (MySQL 8 only) and no multi-valued indexes, so `JSON_CONTAINS` is the only
   option. The `COALESCE` in `jsonArrayContains` is not cosmetic:
   `JSON_CONTAINS(NULL, ...)` is NULL, which stays falsy under `Op.not` and
   would wrongly drop rows whose array column is NULL.

8. **`queryInterface.createTable` only emits a table-level `COLLATE`.** The
   per-column case-insensitive collation on `Users.username` / `email` needs a
   raw `ALTER TABLE ... MODIFY`.

9. **`rowFormat` is not on the typed `createTable` options.** Apply
   `ROW_FORMAT=COMPRESSED` with a separate `ALTER TABLE`.

10. **`utf8mb4_uca1400_as_ci` is the right collation** — case-insensitive but
    accent-sensitive, an exact match for `citext` semantics. Verified: `bob`
    matches `Bob`, `jose` does *not* match `josé`, and `BOB` is rejected as a
    duplicate of `Bob`. Don't settle for `_ai_ci`.

11. **Strict `sql_mode` is set deliberately.** MariaDB silently truncates
    oversized values by default; Postgres errored. `STRICT_ALL_TABLES` preserves
    the old behaviour.

12. **`REDIS_URL` is exported from the shell profile on the dev machine.** It
    leaks into any locally launched server and will make you think you tested
    the no-Redis path when you didn't. Use `env -u REDIS_URL`.

13. **`src/scripts/remove_deleted.ts`** (run by `npm run build-server`) deletes
    compiled `bin/**.js` whose `src` counterpart is gone. After the old
    migrations were removed it correctly purged them from `bin/`, which means no
    rollback path can involve re-running an old migration.

## 7. Runbook

Prerequisites: Docker, `psql`/`pg_restore` (libpq), Node, and a MariaDB 11.4
container. Pin **11.4** to match production; `latest` drifts.

### 7.1 Start a local MariaDB

```bash
docker run -d --name choochoo-mariadb -p 3306:3306 \
  -e MARIADB_ROOT_PASSWORD=choochoo -e MARIADB_DATABASE=choochoo \
  -e MARIADB_USER=choochoo -e MARIADB_PASSWORD=choochoo \
  mariadb:11.4 --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_uca1400_as_cs
```

Sanity check the server supports the collation before going further:

```bash
docker exec choochoo-mariadb mariadb -uroot -pchoochoo \
  -e "SELECT VERSION(); SHOW COLLATION LIKE 'utf8mb4_uca1400_as_c%';"
```

### 7.2 Dump production Postgres

```bash
pg_dump -Fc -d "$PROD_PG_URL" -f dump.pgdump
```

**Take a fresh dump.** The dump used during this work was from 2026-07-24 with
its newest row at 2026-07-25 00:53 UTC, while the site only went into
maintenance on 2026-08-01 — a 7-day gap that would have silently lost a week of
games. Verify freshness:

```sql
SELECT max("createdAt") FROM "Logs";
```

### 7.3 Restore it locally (the ETL reads from a live PG, not the dump file)

```bash
psql "$LOCAL_PG/postgres" -c "CREATE DATABASE aosrestore;"
pg_restore -d "$LOCAL_PG/aosrestore" --no-owner --no-privileges -j 4 dump.pgdump
```

### 7.4 Pre-flight checks on the source

All of these returned 0 / clean last time:

```sql
SELECT count(*) FROM "Games" WHERE "autoStart" IS NULL;                -- ETL coalesces these
SELECT lower(username::text) FROM "Users" GROUP BY 1 HAVING count(*)>1; -- must be empty
SELECT lower(email::text)    FROM "Users" GROUP BY 1 HAVING count(*)>1; -- must be empty
```

The username/email checks matter because the migration collapses two redundant
unique constraints into one case-insensitive index.

### 7.5 Create the schema

```bash
docker exec choochoo-mariadb mariadb -uroot -pchoochoo \
  -e "CREATE DATABASE choochoo CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_as_cs;"
npm run build-server
DATABASE_URL='mariadb://root:choochoo@localhost:3306/choochoo' npm run migrate
```

### 7.6 Run the ETL

```bash
PG_URL='postgres://.../aosrestore' \
DATABASE_URL='mariadb://root:choochoo@localhost:3306/choochoo' \
  npm run etl
```

Resumable — the per-table watermark in `_etl_progress` is committed in the same
transaction as each batch, so a crash can simply be restarted. `--reset`
truncates and starts over; `--verify` reconciles without copying.

### 7.7 Reconcile — gate the cutover on this

```bash
PG_URL=... DATABASE_URL=... npm run etl -- --verify
```

Checks row counts, `sum/min/max(id)`, payload character totals
(`CHAR_LENGTH`, not `LENGTH` — multi-byte chars would disagree spuriously),
JSON array element counts, `JSON_VALID` on every JSON column, and `createdAt`
to the millisecond. Expect `All reconciliation checks passed.`

Reference value for the largest payload, useful as an end-to-end fingerprint:
`SUM(CHAR_LENGTH(previousGameData)) = 4560408386`.

### 7.8 Dump the converted database for transfer

```bash
docker exec choochoo-mariadb mariadb-dump -uroot -pchoochoo \
  --single-transaction --quick --default-character-set=utf8mb4 \
  --no-tablespaces --skip-lock-tables \
  --ignore-table=choochoo._etl_progress \
  choochoo | gzip -6 > choochoo_mariadb.sql.gz
```

Produced 367 MB. Includes schema, `AUTO_INCREMENT` values, the CI collation,
`ROW_FORMAT=COMPRESSED`, and the `SequelizeMeta` row so the app won't try to
re-run the baseline. Contains no `CREATE DATABASE` / `USE`, so it imports into
any database name, and has `DROP TABLE IF EXISTS` so it is re-runnable.

### 7.9 Load into production

Production access, as of 2026-08-01:

- `ssh -p 21098 codertks@eot.coderealms.io` (key auth worked)
- database and user both `codertks_choochoo`, reachable at `127.0.0.1:3306`
- 20 GB database size limit — 3 GB of data is comfortable
- `mysql`, `mariadb` and `mysqldump` all present; `mariadb` is preferred,
  `mysql` prints a deprecation warning
- **unverified:** `@@innodb_file_per_table`. If it is `0`,
  `ROW_FORMAT=COMPRESSED` will fail; strip it with
  `sed 's/ ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8//'` at the cost of ~1.5 GB.

Pre-flight, then transfer with `rsync` (resumable, unlike `scp`):

```bash
mariadb -h 127.0.0.1 -u codertks_choochoo -p -N \
  -e "SELECT VERSION(), @@innodb_file_per_table, @@max_allowed_packet"

rsync -avP -e 'ssh -p 21098' choochoo_mariadb.sql.gz \
  codertks@eot.coderealms.io:~/
```

The import outlasts a flaky SSH session, so detach it. Use a temporary
credentials file to avoid an interactive prompt:

```bash
umask 077 && cat > ~/.my.cnf <<'EOF'
[client]
host=127.0.0.1
user=codertks_choochoo
password=REDACTED
EOF

nohup sh -c 'gzip -dc ~/choochoo_mariadb.sql.gz \
  | mariadb --default-character-set=utf8mb4 codertks_choochoo' \
  > ~/import.log 2>&1 &
```

Then **`rm ~/.my.cnf`** and delete the dump once verified. Note `gzip -dc`, not
macOS `gzcat`. Budget 15–45 minutes.

### 7.10 Verify the load

```sql
SELECT 'Users' t, COUNT(*) actual, 1283 expected FROM Users
UNION ALL SELECT 'Games', COUNT(*), 3024 FROM Games
UNION ALL SELECT 'GameHistories', COUNT(*), 517521 FROM GameHistories
UNION ALL SELECT 'Logs', COUNT(*), 887055 FROM Logs
UNION ALL SELECT 'Feedbacks', COUNT(*), 2410 FROM Feedbacks
UNION ALL SELECT 'SequelizeMeta', COUNT(*), 1 FROM SequelizeMeta;

SELECT COUNT(*) AS bad_json FROM Games WHERE NOT JSON_VALID(playerIds);  -- 0
SELECT AUTO_INCREMENT FROM information_schema.TABLES
  WHERE table_schema = DATABASE() AND table_name = 'Games';              -- 3033
```

(Counts are from the 2026-07-24 dump; re-derive them from whatever dump is
actually used.)

### 7.11 Point the app at it

```
DATABASE_URL=mariadb://codertks_choochoo:PASSWORD@127.0.0.1:3306/codertks_choochoo
```

If the password contains `#`, `%`, `@` or `/`, use the discrete `DB_*` variables
instead — `databaseUrl()` percent-encodes for you when building from those.

The app must run **on** that host for `127.0.0.1` to resolve, or be tunnelled.

## 8. Redis

`f74264e7` makes Redis optional in every environment, because the new host had
none. Three fallbacks, all process-local and therefore **single-instance only**:

- sessions → express-session `MemoryStore`
- socket.io → in-memory adapter (previously `createAdapter` was called
  unconditionally and would have crashed on two `undefined` clients)
- user cache → in-memory `Map` with the same 6-minute TTL, swept on write
  (it previously no-opped without Redis, sending every lookup to the DB)

Consequences: **a restart logs everyone out**, and adding a second app instance
silently breaks sessions, caching and live game updates.

If the migration is revived on a host that *does* have Redis, this commit can be
dropped independently of the rest.

## 9. Not done

- **Deploy scripts were never updated.** `src/scripts/deploy_server.sh` and
  `.github/workflows/deploy.yml` still hardcode `ec2-user@api.choochoo.games`
  and pm2. Deliberately deferred. If the app moves to cPanel this needs
  rewriting (cPanel usually means Passenger / Node selector, often without SSH
  for the deploy user). If the app stays on EC2 with only the DB moving, that
  needs remote MySQL enabled, the EC2 IP allowlisted, `DB_SSL=true`, and a
  latency re-measurement — the app is chatty and every query would cross the
  internet.
- **Exiting maintenance mode.** `src/scripts/deploy_client.sh` and
  `.github/workflows/deploy.yml` ship `static/maintenance.html` as `index.html`.
  Restoring the real site means putting back the
  `upload "src/client/index.html" index.html "dist/index.gz.html"` line and
  removing the two maintenance uploads.
- **Sequelize was upgraded 46 → 48** as part of this work. If reviving much
  later, re-check for a newer alpha; `@sequelize/mariadb` pins
  `@sequelize/core` to an exact version, so both must move together.

## 10. Local scratch state (gone by now, listed for reference)

Recreate with §7 if needed. None of this was committed; `dist` is gitignored and
the dump files were never tracked.

- Docker: `choochoo-mariadb` (MariaDB 11.4.12) with databases `choochoo`
  (migrated data), `choochootest` (integration tests), `codertks_choochoo`
  (import rehearsal); `choochoo-pg`; `choochoo-redis`
- Postgres `aosrestore` — the restored production dump, ~5 GB
- `dump.pgdump` (445 MB), `choochoo_mariadb.sql.gz` (367 MB) in the repo root
- `dist/serve.py` — a throwaway static file server, unrelated to the migration
