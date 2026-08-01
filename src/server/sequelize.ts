import Sequelize from "@sequelize/core";
import { MariaDbDialect } from "@sequelize/mariadb";
import { NextFunction, Request, Response } from "express";
import { logError } from "../utils/functions";
import { FeedbackDao } from "./feedback/dao";
import { GameDao } from "./game/dao";
import { GameHistoryDao } from "./game/history_dao";
import { LogDao } from "./messages/log_dao";
import { UserDao } from "./user/dao";
import {
  databasePoolMax,
  databaseSsl,
  databaseUrl,
} from "./util/environment";

export const sequelize = new Sequelize({
  dialect: MariaDbDialect,
  url: databaseUrl().toString(),
  // logging: log,
  models: [GameDao, UserDao, LogDao, GameHistoryDao, FeedbackDao],
  ssl: databaseSsl(),

  // Store everything in UTC. This must stay a fixed offset: named zones require
  // the server's mysql.time_zone tables to be populated, which shared hosts
  // routinely leave empty.
  timezone: "+00:00",
  charset: "utf8mb4",

  initSql: [
    // The collation is set here rather than via the `collation` connection
    // option because the driver validates that option against a built-in list
    // that predates the uca1400 collations and rejects them. Without this the
    // connection defaults to utf8mb4_uca1400_ai_ci, which is accent-insensitive.
    "SET NAMES utf8mb4 COLLATE utf8mb4_uca1400_as_cs",
    // MariaDB silently truncates oversized values unless strict mode is on.
    // Postgres always errored, so strict mode preserves the behaviour we had.
    "SET SESSION sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'",
  ],

  // Shared hosting caps max_user_connections and kills idle connections, so
  // keep the pool small and recycle connections rather than holding them open.
  pool: {
    max: databasePoolMax(),
    min: 0,
    idle: 10_000,
    acquire: 30_000,
    evict: 5_000,
    maxUses: 500,
  },
  connectTimeout: 10_000,
  socketTimeout: 60_000,
});

let connection: Promise<void>;

export function connectToSequelize() {
  return (connection = sequelize.authenticate());
}

export function waitForSequelize() {
  connectToSequelize().catch((err: unknown) => {
    logError("failed to connect to sql database", err);
    process.exit(1);
  });
  return (req: Request, res: Response, next: NextFunction): void => {
    connection.then(() => next(), next);
  };
}
