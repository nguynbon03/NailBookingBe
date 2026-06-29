import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

export default redis;

export async function lockSlot(date: string, time: string, ttl = 300) {
  const key = `slot:${date}:${time}`;
  const result = await redis.set(key, "locked", "EX", ttl, "NX");
  return result === "OK";
}

export async function unlockSlot(date: string, time: string) {
  const key = `slot:${date}:${time}`;
  return redis.del(key);
}

export async function isSlotLocked(date: string, time: string) {
  const key = `slot:${date}:${time}`;
  const exists = await redis.exists(key);
  return exists === 1;
}
