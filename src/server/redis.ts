import RedisStore from "connect-redis";
import express from "express";
import session from "express-session";
import { Redis } from "ioredis";
import { log, logError } from "../utils/functions";
import { redisUrl, sessionSecret } from "./util/environment";

export let redisClient: Redis | undefined;
export let subClient: Redis | undefined;

function redisStore() {
  const url = redisUrl();
  if (url == null) {
    // express-session falls back to its in-memory MemoryStore. That is only
    // safe for a single instance, and sessions do not survive a restart.
    log("no REDIS_URL set; using in-memory sessions, cache and socket fan-out");
    return;
  }

  redisClient = new Redis({
    host: url.hostname,
    port: Number(url.port),
    username: url.username,
    password: url.password,
  });
  subClient = redisClient.duplicate();

  redisClient.on("error", (e) => {
    logError("redis connection error", e);
    process.exit();
  });

  const redisPrefix = url.pathname.slice(1);

  const redisStore = new RedisStore({
    client: redisClient,
    prefix: `${redisPrefix == "" ? "choo" : redisPrefix}:`,
  });

  return redisStore;
}

export function redisApp() {
  const redisApp = express();

  const sessionParser = session({
    store: redisStore(),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
    secret: sessionSecret(),
  });

  redisApp.use(sessionParser);

  return redisApp;
}
