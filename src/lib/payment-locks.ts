import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { publicAppUrl } from "@/lib/email-verification";

type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export const PAYMENT_HOLD_TTL_SECONDS = Number(process.env.PAYMENT_HOLD_TTL_SECONDS || 180);

let redisClient: Redis | null | undefined;

function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient !== undefined) return redisClient;
  redisClient = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redisClient.on("error", () => undefined);
  return redisClient;
}

export function bookingReference(id: string) {
  return `NL-${id.slice(-8).toUpperCase()}`;
}

function dateKey(dateInput: string | Date) {
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  return date.toISOString().slice(0, 10);
}

export function staffSlotLockKey(staffId: string, dateInput: string | Date, time: string) {
  return `nail:staff-slot:${dateKey(dateInput)}:${time}:${staffId}`;
}

export function paymentTransferUrl(token: string) {
  return `${publicAppUrl()}/payment/transfer?token=${encodeURIComponent(token)}`;
}

async function redisGet(key: string) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    if (redis.status === "wait") await redis.connect();
    return await redis.get(key);
  } catch {
    return null;
  }
}

export async function setStaffSlotRedisLock(bookingId: string, staffId: string, dateInput: string | Date, time: string, ttlSeconds = PAYMENT_HOLD_TTL_SECONDS) {
  const redis = getRedis();
  if (!redis) return true;
  try {
    if (redis.status === "wait") await redis.connect();
    const result = await redis.set(staffSlotLockKey(staffId, dateInput, time), bookingId, "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch {
    // DB hold fields are still written; do not block booking flow just because Redis is temporarily unavailable.
    return true;
  }
}

export async function refreshStaffSlotRedisLock(bookingId: string, staffId: string, dateInput: string | Date, time: string, ttlSeconds = PAYMENT_HOLD_TTL_SECONDS) {
  const redis = getRedis();
  if (!redis) return true;
  try {
    if (redis.status === "wait") await redis.connect();
    const key = staffSlotLockKey(staffId, dateInput, time);
    const current = await redis.get(key);
    if (current && current !== bookingId) return false;
    await redis.set(key, bookingId, "EX", ttlSeconds);
    return true;
  } catch {
    return true;
  }
}

export async function releaseStaffSlotRedisLock(bookingId: string, staffId: string, dateInput: string | Date, time: string) {
  const redis = getRedis();
  if (!redis) return;
  try {
    if (redis.status === "wait") await redis.connect();
    const key = staffSlotLockKey(staffId, dateInput, time);
    const current = await redis.get(key);
    if (current === bookingId) await redis.del(key);
  } catch {
    // best effort only
  }
}

export async function isStaffSlotLocked(tx: PrismaTx, staffId: string, dateInput: string | Date, time: string, ignoreBookingId?: string) {
  const key = staffSlotLockKey(staffId, dateInput, time);
  const redisValue = await redisGet(key);
  if (redisValue && redisValue !== ignoreBookingId) return true;

  const date = new Date(dateKey(dateInput));
  const now = new Date();
  const locked = await tx.booking.findFirst({
    where: {
      date,
      time,
      paymentHoldStaffId: staffId,
      paymentHoldExpiresAt: { gt: now },
      archivedAt: null,
      status: { in: ["PENDING", "CONFIRMED"] },
      ...(ignoreBookingId ? { id: { not: ignoreBookingId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(locked);
}

export function publicBankTransferDetails() {
  return {
    accountName: process.env.BANK_ACCOUNT_NAME || process.env.SHOP_NAME || "The Nail Lounge @ Stokesley",
    bankName: process.env.BANK_NAME || "",
    sortCode: process.env.BANK_SORT_CODE || "",
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || "",
    instructions: process.env.BANK_TRANSFER_INSTRUCTIONS || "Use the booking reference as the transfer reference. Admin will confirm payment after the money reaches the shop account.",
  };
}
