import { DataTypes } from "@sequelize/core";
import type { Migration } from "../scripts/migrations";

/**
 * Baseline schema for MariaDB.
 *
 * This replaces the 33 Postgres-era migrations (see the `pre-mariadb` git tag),
 * which were full of Postgres-only DDL -- citext, native enum types, array
 * columns, `ALTER TYPE`, `::json` casts -- and could never replay on MariaDB.
 * The MariaDB database starts empty, so a single migration that creates the
 * final schema is equivalent to replaying that history.
 *
 * Deliberate differences from the old Postgres schema:
 *  - `Invitations` is not created. It held 0 rows and no model referenced it.
 *  - `Games.status` is VARCHAR rather than a native enum, matching the model.
 *  - `Users.username`/`email` use a case-insensitive collation instead of
 *    citext. utf8mb4_uca1400_as_ci is case-insensitive but accent-sensitive,
 *    which is exactly what citext did.
 *  - Array columns become ordered JSON. They MUST be declared JSON and not
 *    LONGTEXT: the driver only auto-parses columns the server reports as JSON,
 *    so a LONGTEXT column silently yields a string where callers expect an array.
 *  - Large text columns are MEDIUMTEXT; the largest rows in production are
 *    already ~28KB, too close to the 64KB TEXT ceiling.
 *  - No foreign keys, matching production, which has none.
 */

const TABLE_OPTIONS = {
  engine: "InnoDB",
  charset: "utf8mb4",
  collate: "utf8mb4_uca1400_as_cs",
} as const;

const ID = {
  type: DataTypes.INTEGER,
  allowNull: false,
  primaryKey: true,
  autoIncrement: true,
};

/** Every model carries these: @Version plus @CreatedAt/@UpdatedAt/@DeletedAt. */
const BOOKKEEPING = {
  internalVersion: { type: DataTypes.INTEGER, allowNull: false },
  createdAt: { type: DataTypes.DATE(3), allowNull: false },
  updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  deletedAt: { type: DataTypes.DATE(3), allowNull: true },
};

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable(
    "Users",
    {
      id: ID,
      username: { type: DataTypes.STRING, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: false },
      password: { type: DataTypes.STRING, allowNull: false },
      role: { type: DataTypes.STRING, allowNull: false },
      notificationPreferences: { type: DataTypes.JSON, allowNull: false },
      preferredColors: { type: DataTypes.JSON, allowNull: true },
      abandons: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      karma: { type: DataTypes.INTEGER, allowNull: false },
      ...BOOKKEEPING,
    },
    TABLE_OPTIONS,
  );

  // createTable only emits a table-level COLLATE, so the case-insensitive
  // collation for these two columns has to be applied separately.
  await queryInterface.sequelize.query(
    "ALTER TABLE `Users` " +
      "MODIFY `username` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_as_ci NOT NULL, " +
      "MODIFY `email` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_as_ci NOT NULL",
  );

  await queryInterface.addIndex("Users", ["username"], {
    name: "users_username_unique",
    unique: true,
  });
  await queryInterface.addIndex("Users", ["email"], {
    name: "users_email_unique",
    unique: true,
  });

  await queryInterface.createTable(
    "Games",
    {
      id: ID,
      version: { type: DataTypes.INTEGER, allowNull: false },
      gameKey: { type: DataTypes.STRING, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      gameData: { type: DataTypes.TEXT("medium"), allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false },
      playerIds: { type: DataTypes.JSON, allowNull: false },
      ownerId: { type: DataTypes.INTEGER, allowNull: false },
      activePlayerId: { type: DataTypes.INTEGER, allowNull: true },
      undoPlayerId: { type: DataTypes.INTEGER, allowNull: true },
      config: { type: DataTypes.JSON, allowNull: false },
      autoAction: { type: DataTypes.JSON, allowNull: true },
      variant: { type: DataTypes.JSON, allowNull: false },
      notes: { type: DataTypes.JSON, allowNull: true },
      concedingPlayers: { type: DataTypes.JSON, allowNull: false },
      abandonedPlayerIds: { type: DataTypes.JSON, allowNull: false },
      playerFlexTime: { type: DataTypes.JSON, allowNull: true },
      unlisted: { type: DataTypes.BOOLEAN, allowNull: false },
      degenerate: { type: DataTypes.BOOLEAN, allowNull: false },
      minKarma: { type: DataTypes.INTEGER, allowNull: false },
      // Nullable in the old Postgres schema, but the model has always treated
      // it as non-null; the ETL coalesces the stragglers.
      autoStart: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      turnDuration: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 864000000,
      },
      turnStartTime: { type: DataTypes.DATE(3), allowNull: true },
      gameHoursStart: { type: DataTypes.INTEGER, allowNull: false },
      gameHoursDuration: { type: DataTypes.INTEGER, allowNull: false },
      ...BOOKKEEPING,
    },
    TABLE_OPTIONS,
  );

  await queryInterface.createTable(
    "GameHistories",
    {
      id: ID,
      gameVersion: { type: DataTypes.INTEGER, allowNull: false },
      previousGameData: { type: DataTypes.TEXT("medium"), allowNull: true },
      patch: { type: DataTypes.TEXT("medium"), allowNull: true },
      actionName: { type: DataTypes.STRING, allowNull: true },
      actionData: { type: DataTypes.TEXT("medium"), allowNull: true },
      reversible: { type: DataTypes.BOOLEAN, allowNull: false },
      seed: { type: DataTypes.STRING, allowNull: true },
      gameId: { type: DataTypes.INTEGER, allowNull: false },
      userId: { type: DataTypes.INTEGER, allowNull: true },
      ...BOOKKEEPING,
    },
    TABLE_OPTIONS,
  );

  // ~4.7GB of highly compressible JSON text, and ~97% of the dataset.
  // createTable has no option for this, so it is applied separately.
  await queryInterface.sequelize.query(
    "ALTER TABLE `GameHistories` ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8",
  );

  await queryInterface.addIndex("GameHistories", ["gameId", "gameVersion"], {
    name: "game_histories_game_id_game_version",
  });

  await queryInterface.createTable(
    "Logs",
    {
      id: ID,
      message: { type: DataTypes.STRING, allowNull: false },
      userId: { type: DataTypes.INTEGER, allowNull: true },
      gameId: { type: DataTypes.INTEGER, allowNull: true },
      gameVersion: { type: DataTypes.INTEGER, allowNull: true },
      ...BOOKKEEPING,
    },
    TABLE_OPTIONS,
  );

  await queryInterface.addIndex("Logs", ["gameId", "gameVersion"], {
    name: "logs_game_id_game_version",
  });

  await queryInterface.createTable(
    "Feedbacks",
    {
      id: ID,
      userId: { type: DataTypes.INTEGER, allowNull: false },
      errorMessage: { type: DataTypes.TEXT, allowNull: true },
      errorStack: { type: DataTypes.TEXT, allowNull: true },
      userMessage: { type: DataTypes.TEXT, allowNull: true },
      // Widened from varchar(255) to match the model, which says TEXT. Under
      // strict sql_mode an overlong URL would otherwise be an error.
      url: { type: DataTypes.TEXT, allowNull: false },
      ...BOOKKEEPING,
    },
    TABLE_OPTIONS,
  );
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable("Feedbacks");
  await queryInterface.dropTable("Logs");
  await queryInterface.dropTable("GameHistories");
  await queryInterface.dropTable("Games");
  await queryInterface.dropTable("Users");
};
