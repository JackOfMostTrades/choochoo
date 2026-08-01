import { MyUserApi } from "../../api/user";
import { redisClient } from "../redis";

const TTL_MS = 360000;

interface Entry {
  user: MyUserApi;
  expiresAt: number;
}

class UserCache {
  /**
   * Fallback used when Redis is not configured. Correct only because we run a
   * single server instance; with more than one, instances would serve each
   * other's stale users after an update.
   */
  private readonly memory = new Map<number, Entry>();

  async get(id: number): Promise<MyUserApi | undefined> {
    if (redisClient == null) {
      const entry = this.memory.get(id);
      if (entry == null) return undefined;
      if (entry.expiresAt <= Date.now()) {
        this.memory.delete(id);
        return undefined;
      }
      return entry.user;
    }
    const result = await redisClient.get(`users:${id}`);
    if (result == null) return undefined;
    return JSON.parse(result);
  }

  async set(user: MyUserApi | undefined): Promise<void> {
    if (user == null) return;
    if (redisClient == null) {
      this.memory.set(user.id, { user, expiresAt: Date.now() + TTL_MS });
      this.evictExpired();
      return;
    }
    await redisClient.set(
      `users:${user.id}`,
      JSON.stringify(user),
      "PX",
      TTL_MS,
    );
  }

  /**
   * Redis expires keys for us; the in-memory map needs sweeping or it would
   * retain every user who ever logged in. Entries are small and the user count
   * is in the low thousands, so a full scan on write is cheap enough.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.memory) {
      if (entry.expiresAt <= now) {
        this.memory.delete(id);
      }
    }
  }
}

export const userCache = new UserCache();
