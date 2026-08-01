/**
 * One-shot ETL moving production data from PostgreSQL to MariaDB.
 *
 * Deliberately bypasses the Sequelize models: hooks (the UserDao cache hook),
 * @Version bumping, @CreatedAt overrides and validation would all corrupt or
 * slow down a bulk copy. Rows are copied verbatim, ids included.
 *
 * Array and JSONB columns are converted by Postgres itself via to_json(), which
 * is faster than doing it in JS and avoids a class of encoding bugs.
 *
 * Resumable: the per-table watermark is written in the same transaction as the
 * batch insert, so a crash at any point can be restarted safely.
 *
 * Usage:
 *   PG_URL=postgres://... DATABASE_URL=mariadb://... ts-node src/scripts/pg_to_mariadb.ts
 *   ... --verify    reconcile source and target without copying
 *   ... --reset     discard watermarks and truncate target tables first
 */
import mariadb, { Connection } from "mariadb";
import { Client as PgClient } from "pg";

/* eslint-disable no-console */

interface TableSpec {
  /** Target table name, also used as the progress key. */
  name: string;
  /** Target column names, in insert order. */
  columns: string[];
  /**
   * Postgres select list, positionally matching `columns`. Arrays and JSONB are
   * rendered to text here; timestamps are rendered as UTC strings that MariaDB
   * parses directly into DATETIME(3).
   */
  select: string;
  /** Columns holding JSON documents, checked by --verify. */
  jsonColumns?: string[];
  /** Columns whose character length is summed by --verify. */
  payloadColumns?: string[];
}

const ts = (c: string) =>
  `to_char("${c}" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS "${c}"`;

const BOOKKEEPING_COLS = [
  "internalVersion",
  "createdAt",
  "updatedAt",
  "deletedAt",
];
const BOOKKEEPING_SELECT = `"internalVersion", ${ts("createdAt")}, ${ts("updatedAt")}, ${ts("deletedAt")}`;

/**
 * Insert order. There are no foreign keys in either schema, so this is
 * cosmetic today, but it keeps the door open to adding them later.
 */
const TABLES: TableSpec[] = [
  {
    name: "Users",
    columns: [
      "id",
      "username",
      "email",
      "password",
      "role",
      "notificationPreferences",
      "preferredColors",
      "abandons",
      "karma",
      ...BOOKKEEPING_COLS,
    ],
    select: `id, username, email, password, role,
      "notificationPreferences"::text AS "notificationPreferences",
      to_json("preferredColors")::text AS "preferredColors",
      abandons, karma, ${BOOKKEEPING_SELECT}`,
    jsonColumns: ["notificationPreferences", "preferredColors"],
  },
  {
    name: "Games",
    columns: [
      "id",
      "version",
      "gameKey",
      "name",
      "gameData",
      "status",
      "playerIds",
      "ownerId",
      "activePlayerId",
      "undoPlayerId",
      "config",
      "autoAction",
      "variant",
      "notes",
      "concedingPlayers",
      "abandonedPlayerIds",
      "playerFlexTime",
      "unlisted",
      "degenerate",
      "minKarma",
      "autoStart",
      "turnDuration",
      "turnStartTime",
      "gameHoursStart",
      "gameHoursDuration",
      ...BOOKKEEPING_COLS,
    ],
    select: `id, version, "gameKey", name, "gameData", status::text AS status,
      to_json("playerIds")::text AS "playerIds",
      "ownerId", "activePlayerId", "undoPlayerId",
      config::text AS config,
      "autoAction"::text AS "autoAction",
      variant::text AS variant,
      to_json(notes)::text AS notes,
      to_json("concedingPlayers")::text AS "concedingPlayers",
      to_json("abandonedPlayerIds")::text AS "abandonedPlayerIds",
      "playerFlexTime"::text AS "playerFlexTime",
      unlisted::int AS unlisted,
      degenerate::int AS degenerate,
      "minKarma",
      -- nullable in the old schema, non-null in the model
      COALESCE("autoStart", true)::int AS "autoStart",
      "turnDuration", ${ts("turnStartTime")},
      "gameHoursStart", "gameHoursDuration", ${BOOKKEEPING_SELECT}`,
    jsonColumns: [
      "playerIds",
      "config",
      "variant",
      "notes",
      "concedingPlayers",
      "abandonedPlayerIds",
    ],
    payloadColumns: ["gameData"],
  },
  {
    name: "GameHistories",
    columns: [
      "id",
      "gameVersion",
      "previousGameData",
      "patch",
      "actionName",
      "actionData",
      "reversible",
      "seed",
      "gameId",
      "userId",
      ...BOOKKEEPING_COLS,
    ],
    select: `id, "gameVersion", "previousGameData", patch, "actionName", "actionData",
      reversible::int AS reversible, seed, "gameId", "userId", ${BOOKKEEPING_SELECT}`,
    payloadColumns: ["previousGameData", "patch", "actionData"],
  },
  {
    name: "Logs",
    columns: [
      "id",
      "message",
      "userId",
      "gameId",
      "gameVersion",
      ...BOOKKEEPING_COLS,
    ],
    select: `id, message, "userId", "gameId", "gameVersion", ${BOOKKEEPING_SELECT}`,
    payloadColumns: ["message"],
  },
  {
    name: "Feedbacks",
    columns: [
      "id",
      "userId",
      "errorMessage",
      "errorStack",
      "userMessage",
      "url",
      ...BOOKKEEPING_COLS,
    ],
    select: `id, "userId", "errorMessage", "errorStack", "userMessage", url, ${BOOKKEEPING_SELECT}`,
    payloadColumns: ["errorMessage", "errorStack", "userMessage", "url"],
  },
];

/** Rows read from Postgres per round trip. */
const READ_CHUNK = 2000;
/** Hard cap on rows per INSERT, independent of the byte budget. */
const MAX_ROWS_PER_BATCH = 500;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new Error(`must provide ${name}`);
  }
  return value;
}

/** mariadb:// is what the app uses; the driver wants a plain host/user config. */
function mariaConfig() {
  const url = new URL(requireEnv("DATABASE_URL"));
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    // Copy the exact bytes we were given; no client-side date fiddling.
    timezone: "+00:00",
    charset: "utf8mb4",
    // Surface truncation as an error instead of silently corrupting data.
    initSql: [
      "SET NAMES utf8mb4 COLLATE utf8mb4_uca1400_as_cs",
      "SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'",
      "SET SESSION time_zone='+00:00'",
    ],
    // The driver returns BigInt for large ints by default.
    bigIntAsNumber: true,
    multipleStatements: false,
  };
}

async function ensureProgressTable(conn: Connection) {
  await conn.query(`CREATE TABLE IF NOT EXISTS _etl_progress (
    table_name VARCHAR(64) NOT NULL PRIMARY KEY,
    last_id BIGINT NOT NULL DEFAULT 0,
    rows_copied BIGINT NOT NULL DEFAULT 0,
    updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
}

async function getWatermark(
  conn: Connection,
  table: string,
): Promise<number> {
  const rows = await conn.query(
    "SELECT last_id FROM _etl_progress WHERE table_name = ?",
    [table],
  );
  if (rows.length > 0) return Number(rows[0].last_id);
  await conn.query(
    "INSERT INTO _etl_progress (table_name, last_id, rows_copied, updated_at) VALUES (?, 0, 0, UTC_TIMESTAMP(3))",
    [table],
  );
  return 0;
}

/** Rough serialized size, used to stay well under max_allowed_packet. */
function rowBytes(row: unknown[]): number {
  let total = 0;
  for (const value of row) {
    if (value == null) total += 4;
    else if (typeof value === "string") total += Buffer.byteLength(value);
    else total += 8;
  }
  return total;
}

async function copyTable(
  pg: PgClient,
  conn: Connection,
  spec: TableSpec,
  byteBudget: number,
) {
  const startedAt = Date.now();
  let lastId = await getWatermark(conn, spec.name);
  if (lastId > 0) {
    console.log(`  resuming ${spec.name} from id > ${lastId}`);
  }

  const placeholders = `(${spec.columns.map(() => "?").join(",")})`;
  const insertSql =
    `INSERT INTO \`${spec.name}\` (${spec.columns.map((c) => `\`${c}\``).join(",")}) ` +
    `VALUES ${placeholders}`;

  let copied = 0;
  for (;;) {
    const { rows } = await pg.query(
      `SELECT ${spec.select} FROM "${spec.name}" WHERE id > $1 ORDER BY id LIMIT $2`,
      [lastId, READ_CHUNK],
    );
    if (rows.length === 0) break;

    let batch: unknown[][] = [];
    let batchBytes = 0;
    let batchLastId = lastId;

    const flush = async () => {
      if (batch.length === 0) return;
      await conn.beginTransaction();
      try {
        await conn.batch(insertSql, batch);
        await conn.query(
          "UPDATE _etl_progress SET last_id = ?, rows_copied = rows_copied + ?, updated_at = UTC_TIMESTAMP(3) WHERE table_name = ?",
          [batchLastId, batch.length, spec.name],
        );
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }
      copied += batch.length;
      lastId = batchLastId;
      batch = [];
      batchBytes = 0;
    };

    for (const row of rows) {
      const values = spec.columns.map((c) => (row as never)[c] ?? null);
      const bytes = rowBytes(values);
      if (
        batch.length > 0 &&
        (batchBytes + bytes > byteBudget || batch.length >= MAX_ROWS_PER_BATCH)
      ) {
        await flush();
      }
      batch.push(values);
      batchBytes += bytes;
      batchLastId = Number((row as { id: number }).id);
    }
    await flush();

    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(
      `  ${spec.name}: ${copied} rows (${Math.round(copied / Math.max(elapsed, 1))}/s), last id ${lastId}`,
    );
  }

  // InnoDB derives AUTO_INCREMENT from MAX(id) on load, but set it explicitly
  // so a restart can never hand out a colliding primary key.
  const [{ maxId }] = await conn.query(
    `SELECT COALESCE(MAX(id), 0) AS maxId FROM \`${spec.name}\``,
  );
  await conn.query(
    `ALTER TABLE \`${spec.name}\` AUTO_INCREMENT = ${Number(maxId) + 1}`,
  );
  console.log(
    `  ${spec.name}: done, ${copied} rows this run, AUTO_INCREMENT=${Number(maxId) + 1}`,
  );
}

async function verify(pg: PgClient, conn: Connection) {
  let failures = 0;
  const compare = (label: string, a: unknown, b: unknown) => {
    const ok = String(a ?? "∅") === String(b ?? "∅");
    if (!ok) failures++;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label}: pg=${a} maria=${b}`);
  };

  for (const spec of TABLES) {
    console.log(`\n${spec.name}`);

    // 1 + 2: counts and id aggregates catch gaps, dupes and truncation.
    const pgAgg = (
      await pg.query(
        `SELECT count(*)::bigint AS n, COALESCE(sum(id),0)::bigint AS s,
                COALESCE(min(id),0) AS lo, COALESCE(max(id),0) AS hi FROM "${spec.name}"`,
      )
    ).rows[0];
    const [mAgg] = await conn.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(id),0) AS s,
              COALESCE(MIN(id),0) AS lo, COALESCE(MAX(id),0) AS hi FROM \`${spec.name}\``,
    );
    compare("count", pgAgg.n, mAgg.n);
    compare("sum(id)", pgAgg.s, mAgg.s);
    compare("min(id)", pgAgg.lo, mAgg.lo);
    compare("max(id)", pgAgg.hi, mAgg.hi);

    // 3: payload integrity. CHAR_LENGTH, not LENGTH -- multi-byte characters
    // would otherwise disagree with Postgres' length().
    for (const col of spec.payloadColumns ?? []) {
      const pgLen = (
        await pg.query(
          `SELECT COALESCE(sum(length("${col}")),0)::bigint AS v FROM "${spec.name}"`,
        )
      ).rows[0].v;
      const [mLen] = await conn.query(
        `SELECT COALESCE(SUM(CHAR_LENGTH(\`${col}\`)),0) AS v FROM \`${spec.name}\``,
      );
      compare(`sum(len(${col}))`, pgLen, mLen.v);
    }

    // 4: array/JSON conversion preserved element counts.
    for (const col of spec.jsonColumns ?? []) {
      const pgLen = (
        await pg.query(
          `SELECT COALESCE(sum(json_array_length(to_json("${col}"))),0)::bigint AS v
           FROM "${spec.name}" WHERE json_typeof(to_json("${col}")) = 'array'`,
        )
      ).rows[0].v;
      const [mLen] = await conn.query(
        `SELECT COALESCE(SUM(JSON_LENGTH(\`${col}\`)),0) AS v
         FROM \`${spec.name}\` WHERE JSON_TYPE(\`${col}\`) = 'ARRAY'`,
      );
      compare(`sum(json_length(${col}))`, pgLen, mLen.v);

      // 7: every JSON document must be valid.
      const [invalid] = await conn.query(
        `SELECT COUNT(*) AS v FROM \`${spec.name}\`
         WHERE \`${col}\` IS NOT NULL AND NOT JSON_VALID(\`${col}\`)`,
      );
      compare(`invalid json in ${col}`, 0, invalid.v);
    }

    // 5: timestamps survived to the millisecond.
    const pgStamps = (
      await pg.query(
        `SELECT id, to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS c
         FROM "${spec.name}" ORDER BY id LIMIT 500`,
      )
    ).rows;
    if (pgStamps.length > 0) {
      const ids = pgStamps.map((r: { id: number }) => r.id);
      const mStamps = await conn.query(
        `SELECT id, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s.%f') AS c
         FROM \`${spec.name}\` WHERE id IN (${ids.join(",")})`,
      );
      const mById = new Map(
        mStamps.map((r: { id: number; c: string }) => [
          Number(r.id),
          r.c.slice(0, 23),
        ]),
      );
      const mismatched = pgStamps.filter(
        (r: { id: number; c: string }) => mById.get(Number(r.id)) !== r.c,
      );
      compare(`createdAt ms mismatches (of ${pgStamps.length})`, 0, mismatched.length);
    }
  }

  console.log(
    failures === 0
      ? "\nAll reconciliation checks passed."
      : `\n${failures} RECONCILIATION CHECK(S) FAILED -- do not cut over.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const pg = new PgClient({ connectionString: requireEnv("PG_URL") });
  await pg.connect();
  const conn = await mariadb.createConnection(mariaConfig());

  try {
    if (args.has("--verify")) {
      await verify(pg, conn);
      return;
    }

    await ensureProgressTable(conn);

    if (args.has("--reset")) {
      console.log("resetting target tables");
      await conn.query("SET FOREIGN_KEY_CHECKS=0");
      for (const spec of [...TABLES].reverse()) {
        await conn.query(`TRUNCATE TABLE \`${spec.name}\``);
      }
      await conn.query("SET FOREIGN_KEY_CHECKS=1");
      await conn.query("DELETE FROM _etl_progress");
    }

    const [{ v: maxPacket }] = await conn.query(
      "SELECT @@max_allowed_packet AS v",
    );
    const byteBudget = Math.floor(Number(maxPacket) * 0.25);
    console.log(
      `max_allowed_packet=${maxPacket}, batch byte budget=${byteBudget}`,
    );

    // Bulk-load settings. sql_mode stays strict on purpose.
    await conn.query("SET SESSION unique_checks=0");
    await conn.query("SET SESSION foreign_key_checks=0");

    for (const spec of TABLES) {
      console.log(`\ncopying ${spec.name}`);
      await copyTable(pg, conn, spec, byteBudget);
    }

    await conn.query("SET SESSION unique_checks=1");
    await conn.query("SET SESSION foreign_key_checks=1");
    console.log("\nCopy complete. Re-run with --verify to reconcile.");
  } finally {
    await conn.end();
    await pg.end();
  }
}

main().catch((e) => {
  console.error("ETL FAILED:", e);
  process.exit(1);
});
