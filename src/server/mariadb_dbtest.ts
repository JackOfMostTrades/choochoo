/**
 * MariaDB integration regression tests.
 *
 * These cover the behaviours that changed shape in the Postgres -> MariaDB
 * migration and that unit tests cannot reach, because they depend on what the
 * server and driver actually do rather than on generated SQL.
 */
import { Op, Sequelize } from "@sequelize/core";
import { GameStatus } from "../api/game";
import { GameDao } from "./game/dao";
import { LogDao } from "./messages/log_dao";
import { connectToSequelize, sequelize } from "./sequelize";
import { UserDao } from "./user/dao";
import { jsonArrayContains } from "./util/json_query";

/** Unique-ish suffix so parallel or repeated runs do not collide. */
let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}_${process.pid}_${seq}`;
}

async function makeUser(overrides: Partial<UserDao> = {}): Promise<UserDao> {
  const name = unique("dbtest");
  return UserDao.create({
    username: name,
    email: `${name}@example.com`,
    password: "hunter2hunter2",
    role: "USER",
    abandons: 0,
    karma: 20,
    notificationPreferences: { marketing: false, turnNotifications: [] },
    ...overrides,
  } as never);
}

async function makeGame(overrides: Partial<GameDao> = {}): Promise<GameDao> {
  return GameDao.create({
    version: 1,
    gameKey: "rust-belt",
    name: unique("game"),
    status: GameStatus.enum.LOBBY,
    playerIds: [],
    ownerId: 1,
    unlisted: false,
    degenerate: false,
    minKarma: 0,
    autoStart: false,
    turnDuration: 1000,
    gameHoursStart: 0,
    gameHoursDuration: 24,
    concedingPlayers: [],
    abandonedPlayerIds: [],
    config: { minPlayers: 2, maxPlayers: 6 },
    variant: { gameKey: "rust-belt" },
    ...overrides,
  } as never);
}

describe("MariaDB persistence", () => {
  const games: GameDao[] = [];
  const users: UserDao[] = [];

  beforeAll(async () => {
    await connectToSequelize();
  });

  afterAll(async () => {
    for (const game of games) {
      await LogDao.destroy({ where: { gameId: game.id }, force: true });
      await GameDao.destroy({ where: { id: game.id }, force: true });
    }
    for (const user of users) {
      await UserDao.destroy({ where: { id: user.id }, force: true });
    }
    await sequelize.close();
  });

  async function trackGame(overrides: Partial<GameDao> = {}) {
    const game = await makeGame(overrides);
    games.push(game);
    return game;
  }

  async function trackUser(overrides: Partial<UserDao> = {}) {
    const user = await makeUser(overrides);
    users.push(user);
    return user;
  }

  describe("JSON columns", () => {
    // MariaDB stores JSON as LONGTEXT + a json_valid CHECK, so information_schema
    // reports "longtext" and there is no column type to assert on. The only
    // meaningful guard is that values round-trip as real arrays/objects: if this
    // regresses, callers silently get strings and `playerIds.indexOf(...)` breaks.
    it("round-trips an array preserving order", async () => {
      const game = await trackGame({ playerIds: [3, 1, 2] } as never);
      const reloaded = await GameDao.findByPk(game.id);
      expect(Array.isArray(reloaded!.playerIds)).toBe(true);
      expect(reloaded!.playerIds).toEqual([3, 1, 2]);
    });

    it("preserves null elements inside an array", async () => {
      const game = await trackGame({ notes: ["a", null, "c"] } as never);
      const reloaded = await GameDao.findByPk(game.id);
      expect(reloaded!.notes).toEqual(["a", null, "c"]);
    });

    it("round-trips an object", async () => {
      const game = await trackGame({
        config: { minPlayers: 3, maxPlayers: 5 },
      } as never);
      const reloaded = await GameDao.findByPk(game.id);
      expect(reloaded!.config).toEqual({ minPlayers: 3, maxPlayers: 5 });
    });

    it("round-trips an empty array rather than null", async () => {
      const game = await trackGame({ concedingPlayers: [] } as never);
      const reloaded = await GameDao.findByPk(game.id);
      expect(reloaded!.concedingPlayers).toEqual([]);
    });

    it("round-trips preferredColors on the user model", async () => {
      const user = await trackUser({ preferredColors: [5, 2] } as never);
      const reloaded = await UserDao.findByPk(user.id);
      expect(reloaded!.preferredColors).toEqual([5, 2] as never);
    });
  });

  describe("notes are addressed by position within playerIds", () => {
    it("reads and writes the calling user's slot", async () => {
      const game = await trackGame({
        playerIds: [11, 22, 33],
        notes: null,
      } as never);
      game.setNotesForUser(22, "second seat");
      await game.save();

      const reloaded = await GameDao.findByPk(game.id);
      expect(reloaded!.getNotesForUser(22)).toEqual("second seat");
      expect(reloaded!.getNotesForUser(11)).toEqual("");
    });
  });

  describe("username collation", () => {
    it("matches case-insensitively", async () => {
      const user = await trackUser();
      const found = await UserDao.findOne({
        where: { username: user.username.toUpperCase() },
      });
      expect(found?.id).toEqual(user.id);
    });

    it("is accent-sensitive, matching the old citext behaviour", async () => {
      // utf8mb4_uca1400_as_ci, not _ai_ci: "jose" must not match "josé".
      const name = unique("josé");
      const user = await trackUser({ username: name } as never);
      expect(user.id).toBeDefined();
      const found = await UserDao.findOne({
        where: { username: name.replace("é", "e") },
      });
      expect(found).toBeNull();
    });

    it("rejects a case-variant duplicate username", async () => {
      const user = await trackUser();
      await expectAsync(
        makeUser({
          username: user.username.toUpperCase(),
          email: `other_${user.username}@example.com`,
        } as never),
      ).toBeRejected();
    });
  });

  describe("jsonArrayContains", () => {
    it("filters by array membership and honours negation", async () => {
      const marker = 900000 + (process.pid % 10000);
      const member = await trackGame({ playerIds: [marker, 1] } as never);
      const abandoned = await trackGame({
        playerIds: [marker],
        abandonedPlayerIds: [marker],
      } as never);
      const owner = await trackGame({ ownerId: marker } as never);
      const unrelated = await trackGame({ playerIds: [1] } as never);

      const ids = [member.id, abandoned.id, owner.id, unrelated.id];
      const rows = await GameDao.findAll({
        where: {
          [Op.and]: [
            { id: { [Op.in]: ids } },
            {
              [Op.or]: [
                jsonArrayContains("playerIds", marker),
                { ownerId: marker },
              ],
            },
            { [Op.not]: jsonArrayContains("abandonedPlayerIds", marker) },
          ],
        },
      });

      expect(rows.map((r) => r.id).sort()).toEqual(
        [member.id, owner.id].sort(),
      );
    });
  });

  describe("timestamps", () => {
    it("keeps millisecond precision", async () => {
      const when = new Date("2026-03-04T05:06:07.123Z");
      const game = await trackGame({ turnStartTime: when } as never);
      const reloaded = await GameDao.findByPk(game.id);
      expect(reloaded!.turnStartTime!.toISOString()).toEqual(
        when.toISOString(),
      );
    });
  });

  describe("bulkCreate", () => {
    it("returns numeric ids rather than BigInt", async () => {
      const game = await trackGame();
      const logs = await LogDao.bulkCreate([
        { message: "a", gameId: game.id, previousGameVersion: 1 },
        { message: "b", gameId: game.id, previousGameVersion: 1 },
      ] as never);
      for (const log of logs) {
        expect(typeof log.id).toEqual("number");
      }
    });
  });

  describe("optimistic locking", () => {
    it("rejects a stale write", async () => {
      const game = await trackGame();
      const first = await GameDao.findByPk(game.id);
      const second = await GameDao.findByPk(game.id);
      first!.name = unique("first");
      second!.name = unique("second");
      await first!.save();
      await expectAsync(second!.save()).toBeRejected();
    });
  });

  describe("strict sql_mode", () => {
    it("rejects an overlong value instead of truncating it", async () => {
      const game = await trackGame();
      await expectAsync(
        LogDao.create({
          message: "x".repeat(300),
          gameId: game.id,
        } as never),
      ).toBeRejected();
    });
  });

  describe("connection session", () => {
    it("uses an accent-sensitive, case-sensitive connection collation", async () => {
      // Guards against the `charset`-only config, which silently yields
      // utf8mb4_uca1400_ai_ci.
      const [row] = (await sequelize.query(
        "SELECT @@collation_connection AS c",
        { type: "SELECT" as never },
      )) as unknown as Array<{ c: string }>;
      expect(row.c).toEqual("utf8mb4_uca1400_as_cs");
    });

    it("runs in UTC", async () => {
      const [row] = (await sequelize.query("SELECT @@time_zone AS tz", {
        type: "SELECT" as never,
      })) as unknown as Array<{ tz: string }>;
      expect(row.tz).toEqual("+00:00");
    });
  });

  it("exposes the mariadb dialect", () => {
    expect(sequelize.dialect.name).toEqual("mariadb");
    expect(sequelize instanceof Sequelize).toBe(true);
  });
});
