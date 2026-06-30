import { NextRequest } from "next/server";
type PrismaDb = any;

type AuthUser = {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
};

export type ProtectionDecision = {
  sourceIp: string | null;
  userAgent: string | null;
  depositRequired: boolean;
  depositAmount: number;
  depositMode: string;
  reasons: string[];
};

const ACTIVE_BOOKING_STATUSES = ["PENDING", "CONFIRMED"] as const;
const COUNTED_DAILY_STATUSES = ["PENDING", "CONFIRMED", "COMPLETED", "NO_SHOW"] as const;

function cleanHeaderValue(value: string | null) {
  const first = String(value || "").split(",")[0]?.trim() || "";
  return first.slice(0, 120) || null;
}

export function getClientIp(req: NextRequest) {
  return (
    cleanHeaderValue(req.headers.get("cf-connecting-ip")) ||
    cleanHeaderValue(req.headers.get("x-real-ip")) ||
    cleanHeaderValue(req.headers.get("x-forwarded-for")) ||
    cleanHeaderValue(req.headers.get("forwarded")?.match(/for=([^;,]+)/i)?.[1] || null)
  );
}

export function getUserAgent(req: NextRequest) {
  return String(req.headers.get("user-agent") || "").slice(0, 500) || null;
}

export function normalizePhone(value: unknown) {
  const raw = String(value || "").trim();
  const plus = raw.startsWith("+") ? "+" : "";
  const digits = raw.replace(/\D/g, "");
  return (plus + digits).slice(0, 40);
}

export function normalizeBlockValue(type: unknown, value: unknown) {
  const t = String(type || "").trim().toUpperCase();
  if (t === "EMAIL") return String(value || "").trim().toLowerCase();
  if (t === "PHONE") return normalizePhone(value);
  if (t === "IP") return String(value || "").trim().toLowerCase().slice(0, 120);
  return String(value || "").trim().toLowerCase();
}

export function normalizeBlockType(type: unknown) {
  const value = String(type || "").trim().toUpperCase();
  return ["EMAIL", "PHONE", "IP"].includes(value) ? value : "EMAIL";
}

function dayRange(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export async function getProtectionSettings(prisma: PrismaDb) {
  return prisma.bookingProtectionSetting.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      depositMode: "SMART",
      depositAmount: 10,
      highValueThreshold: 50,
      maxActiveBookingsPerCustomer: 2,
      maxBookingsPerPhonePerDay: 3,
      maxBookingsPerEmailPerDay: 3,
      maxBookingsPerIpPerDay: 8,
      requireDepositForNewCustomer: true,
      requireDepositForWeekend: true,
      requireDepositForHighValue: true,
      customerExportEnabled: true,
    },
    update: {},
  });
}

export async function assessBookingProtection(
  prisma: PrismaDb,
  req: NextRequest,
  input: {
    authUser: AuthUser;
    email: string;
    phone: string;
    requestedDate: Date;
    totalPrice: number;
  }
): Promise<ProtectionDecision> {
  const sourceIp = getClientIp(req);
  const userAgent = getUserAgent(req);
  const phone = normalizePhone(input.phone);
  const email = String(input.email || "").trim().toLowerCase();
  const settings = await getProtectionSettings(prisma);

  const blockChecks = [
    { type: "EMAIL", value: email },
    { type: "PHONE", value: phone },
    { type: "IP", value: sourceIp || "" },
  ].filter((item) => item.value);

  if (blockChecks.length) {
    const blocked = await prisma.customerBlocklist.findFirst({
      where: {
        active: true,
        OR: blockChecks.map((item) => ({ type: item.type, value: normalizeBlockValue(item.type, item.value) })),
      },
    });
    if (blocked) {
      const label = blocked.type === "IP" ? "network" : blocked.type.toLowerCase();
      throw new Error(`Booking blocked: this ${label} is on the shop blacklist${blocked.reason ? ` (${blocked.reason})` : ""}. Please contact the shop.`);
    }
  }

  const { start, end } = dayRange();
  const [activeCount, phoneDayCount, emailDayCount, ipDayCount, previousGoodCount, noShowCount] = await Promise.all([
    prisma.booking.count({
      where: { userId: input.authUser.id, archivedAt: null, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
    }),
    phone
      ? prisma.booking.count({
          where: { customerPhone: input.phone, createdAt: { gte: start, lt: end }, status: { in: [...COUNTED_DAILY_STATUSES] } },
        })
      : Promise.resolve(0),
    email
      ? prisma.booking.count({
          where: { customerEmail: email, createdAt: { gte: start, lt: end }, status: { in: [...COUNTED_DAILY_STATUSES] } },
        })
      : Promise.resolve(0),
    sourceIp
      ? prisma.booking.count({
          where: { sourceIp, createdAt: { gte: start, lt: end }, status: { in: [...COUNTED_DAILY_STATUSES] } },
        })
      : Promise.resolve(0),
    prisma.booking.count({
      where: { userId: input.authUser.id, status: { in: ["CONFIRMED", "COMPLETED"] } },
    }),
    prisma.booking.count({
      where: { OR: [{ userId: input.authUser.id }, { customerEmail: email }, ...(phone ? [{ customerPhone: input.phone }] : [])], status: "NO_SHOW" },
    }),
  ]);

  if (activeCount >= settings.maxActiveBookingsPerCustomer) {
    throw new Error(`Booking limit reached: this account already has ${activeCount} active booking(s). Please complete/cancel one before creating another.`);
  }
  if (phone && phoneDayCount >= settings.maxBookingsPerPhonePerDay) {
    throw new Error(`Booking limit reached: this phone number already created ${phoneDayCount} booking(s) today.`);
  }
  if (email && emailDayCount >= settings.maxBookingsPerEmailPerDay) {
    throw new Error(`Booking limit reached: this email already created ${emailDayCount} booking(s) today.`);
  }
  if (sourceIp && ipDayCount >= settings.maxBookingsPerIpPerDay) {
    throw new Error(`Booking limit reached: this network already created ${ipDayCount} booking(s) today. Please call the shop if this is a real customer.`);
  }

  const reasons: string[] = [];
  const mode = String(settings.depositMode || "OFF").toUpperCase();
  let depositRequired = mode === "REQUIRED";
  const day = input.requestedDate.getDay();
  const isWeekend = day === 0 || day === 6;
  const totalPrice = Number(input.totalPrice || 0);
  const highValueThreshold = Number(settings.highValueThreshold || 0);

  if (mode === "SMART") {
    if (settings.requireDepositForNewCustomer && previousGoodCount === 0) {
      depositRequired = true;
      reasons.push("new customer");
    }
    if (settings.requireDepositForWeekend && isWeekend) {
      depositRequired = true;
      reasons.push("weekend/peak slot");
    }
    if (settings.requireDepositForHighValue && highValueThreshold > 0 && totalPrice >= highValueThreshold) {
      depositRequired = true;
      reasons.push("high value service");
    }
    if (noShowCount > 0) {
      depositRequired = true;
      reasons.push("previous no-show history");
    }
  }

  if (mode === "REQUIRED") reasons.push("shop requires deposit for every online booking");

  return {
    sourceIp,
    userAgent,
    depositRequired,
    depositAmount: depositRequired ? Number(settings.depositAmount || 0) : 0,
    depositMode: mode,
    reasons,
  };
}
