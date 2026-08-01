import { MyUserApi } from "../../api/user";
import { redisClient } from "../redis";
import { userCache } from "./cache";

/**
 * Exercises the in-memory fallback. `redisClient` is only assigned when
 * REDIS_URL is set and redisStore() runs, neither of which happens under the
 * unit test runner, so these tests always take the in-memory path.
 */
describe("userCache without redis", () => {
  function user(id: number): MyUserApi {
    return { id, username: `user${id}` } as MyUserApi;
  }

  beforeEach(() => {
    expect(redisClient)
      .withContext("these tests are only meaningful without redis")
      .toBeUndefined();
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1700000000000));
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it("returns undefined for an unknown user", async () => {
    await expectAsync(userCache.get(90001)).toBeResolvedTo(undefined);
  });

  it("round-trips a user", async () => {
    await userCache.set(user(90002));
    await expectAsync(userCache.get(90002)).toBeResolvedTo(user(90002));
  });

  it("ignores an undefined user", async () => {
    await userCache.set(undefined);
    await expectAsync(userCache.get(90003)).toBeResolvedTo(undefined);
  });

  it("overwrites an existing entry", async () => {
    await userCache.set({ id: 90004, username: "before" } as MyUserApi);
    await userCache.set({ id: 90004, username: "after" } as MyUserApi);
    const cached = await userCache.get(90004);
    expect(cached?.username).toEqual("after");
  });

  it("expires an entry once its ttl elapses", async () => {
    await userCache.set(user(90005));
    jasmine.clock().tick(359999);
    await expectAsync(userCache.get(90005)).toBeResolvedTo(user(90005));
    jasmine.clock().tick(2);
    await expectAsync(userCache.get(90005)).toBeResolvedTo(undefined);
  });
});
