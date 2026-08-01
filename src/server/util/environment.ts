import { URL } from "url";
import { z } from "zod";
import { readFileSync } from "fs";
import { assert } from "../../utils/validate";
import { isNotEmpty } from "../../utils/functions";

export const Stage = z.enum(["production", "development", "test"]);
export type Stage = z.infer<typeof Stage>;

export function stage(): Stage {
  return Stage.parse(process.env.NODE_ENV);
}

/**
 * SSL config for the database connection. `DB_SSL_CA` points at a CA bundle on
 * disk; `DB_SSL=true` enables SSL using the system trust store.
 */
export function databaseSsl(): { ca: string } | boolean | undefined {
  const ca = process.env.DB_SSL_CA;
  if (isNotEmpty(ca)) return { ca: readFileSync(ca, "utf-8") };
  return process.env.DB_SSL === "true" ? true : undefined;
}

/**
 * The database connection URL. Prefers DATABASE_URL, otherwise assembles one
 * from the discrete DB_* variables -- shared hosts hand out host/user/password
 * separately, and building via `new URL` percent-encodes passwords containing
 * characters like `#`, `%`, `@` and `/`.
 *
 * The scheme must be `mariadb:`; @sequelize/mariadb rejects anything else
 * (including `mysql:`) when parsing the URL.
 */
export function databaseUrl(): URL {
  if (isNotEmpty(process.env.DATABASE_URL)) {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    assert(
      databaseUrl.protocol === "mariadb:",
      "DATABASE_URL must use the mariadb:// scheme",
    );
    return databaseUrl;
  }
  assert(
    isNotEmpty(process.env.DB_PASS),
    "must provide DATABASE_URL or DB_PASS",
  );
  const url = new URL("mariadb://choochoo:password@localhost:3306/choochoo");
  url.password = process.env.DB_PASS;
  if (isNotEmpty(process.env.DB_USER)) {
    url.username = process.env.DB_USER;
  }
  if (isNotEmpty(process.env.DB_HOST)) {
    url.hostname = process.env.DB_HOST;
  }
  if (isNotEmpty(process.env.DB_PORT)) {
    url.port = process.env.DB_PORT;
  }
  if (isNotEmpty(process.env.DB_NAME)) {
    url.pathname = "/" + process.env.DB_NAME;
  }
  return url;
}

/** Connection pool size. Shared hosts cap max_user_connections aggressively. */
export function databasePoolMax(): number {
  return Number(process.env.DB_POOL_MAX ?? 6);
}

export function redisUrl(): URL | undefined {
  const redisUrl = process.env.REDIS_URL;
  if (stage() === Stage.enum.production) {
    assert(redisUrl != null, "must provide a redis url");
  }
  return redisUrl == null ? undefined : new URL(redisUrl);
}

export function sessionSecret(): string {
  const sessionSecret = process.env.SESSION_SECRET;
  if (stage() === Stage.enum.production) {
    assert(sessionSecret != null, "must provide a session secret");
  }
  return sessionSecret ?? "foobar";
}

export function mailjet() {
  const key = process.env.MAILJET_KEY;
  const secret = process.env.MAILJET_SECRET;
  if (key == null || secret == null) return undefined;
  return {
    key,
    secret,
  };
}

export function clientOrigin() {
  const origin = process.env.CLIENT_ORIGIN;
  if (stage() === Stage.enum.production) {
    assert(origin != null, "must provide CLIENT_ORIGIN in prd mode");
  }
  return origin;
}

export function port() {
  return Number(process.env.PORT ?? 3000);
}

export function webhookUrls() {
  return {
    aos: process.env.AOS_DISCORD_WEBHOOK_URL,
    eot: process.env.EOT_DISCORD_WEBHOOK_URL,
  };
}

export function cryptoSecret() {
  const cryptoSecret = process.env.CRYPTO_SECRET;
  if (stage() === Stage.enum.production) {
    assert(cryptoSecret != null, "must provide a crypto secret");
  }
  return cryptoSecret ?? "bb90c03bfc07af7e93eef09933764a86";
}

export function loginBypass() {
  return {
    loginIds: process.env.LOGIN_IDS?.split(",").map((id) => Number(id)) ?? [],
    loginKey: process.env.LOGIN_KEY,
  };
}
