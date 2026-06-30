import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";

type PrismaLike = PrismaClient;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function parseAmount(value: unknown) {
  const raw = clean(value).replace(/[£,$]/g, "").replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function parseDate(value: unknown) {
  const raw = clean(value);
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) return date;
  const m = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
  }
  return new Date();
}

function csvSplit(line: string) {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeHeader(header: string) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(row: Record<string, string>, names: string[]) {
  for (const name of names) {
    const key = Object.keys(row).find((k) => normalizeHeader(k) === normalizeHeader(name));
    if (key && row[key] != null && row[key] !== "") return row[key];
  }
  return "";
}

export function parseBankStatementCsv(csv: string) {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = csvSplit(lines[0]).map((h) => clean(h));
  return lines.slice(1).map((line) => {
    const cells = csvSplit(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = clean(cells[i]); });
    const date = parseDate(pick(row, ["date", "transaction date", "posted date", "booking date"]));
    const description = pick(row, ["description", "details", "narrative", "merchant", "name"]);
    const reference = pick(row, ["reference", "ref", "payment reference", "memo"]);
    const paidIn = parseAmount(pick(row, ["paid in", "credit", "money in", "amount in"]));
    const paidOut = parseAmount(pick(row, ["paid out", "debit", "money out", "amount out"]));
    let amount = parseAmount(pick(row, ["amount", "value"]));
    if (!amount && paidIn) amount = paidIn;
    if (!amount && paidOut) amount = -Math.abs(paidOut);
    const bankAccount = pick(row, ["account", "account number", "bank account"]);
    const currency = pick(row, ["currency", "ccy"]) || "GBP";
    const rawKey = `${date.toISOString().slice(0,10)}|${amount}|${description}|${reference}|${bankAccount}`;
    const fingerprint = createHash("sha256").update(rawKey).digest("hex");
    return { date, description, reference, amount, currency, bankAccount, fingerprint, raw: row };
  }).filter((row) => row.description || row.reference || row.amount);
}

function referenceCandidates(text: string) {
  const refs = new Set<string>();
  for (const match of text.matchAll(/NL-[A-Z0-9]{4,}/gi)) refs.add(match[0].toUpperCase());
  for (const match of text.matchAll(/[A-Z0-9]{8,}/gi)) refs.add(`NL-${match[0].slice(-8).toUpperCase()}`);
  return Array.from(refs);
}

async function matchBooking(prisma: PrismaLike, entry: { description: string; reference: string; amount: number; date: Date }) {
  const text = `${entry.reference || ""} ${entry.description || ""}`;
  const refs = referenceCandidates(text);
  if (refs.length) {
    const found = await prisma.booking.findFirst({
      where: { OR: refs.map((ref) => ({ paymentReference: ref })) },
      select: { id: true, totalPrice: true, customerName: true, paymentReference: true },
    });
    if (found) return { bookingId: found.id, confidence: 98 };
  }
  const amount = Math.abs(Number(entry.amount || 0));
  const start = new Date(entry.date);
  start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(entry.date);
  end.setUTCDate(end.getUTCDate() + 7);
  const fuzzy = await prisma.booking.findFirst({
    where: {
      date: { gte: start, lte: end },
      totalPrice: amount,
      customerName: { contains: entry.description.split(/\s+/)[0] || "__no_match__", mode: "insensitive" },
    },
    select: { id: true },
  });
  if (fuzzy) return { bookingId: fuzzy.id, confidence: 70 };
  return { bookingId: null, confidence: null };
}

export async function importBankStatementCsv(prisma: PrismaLike, csv: string, source = "manual_statement") {
  const rows = parseBankStatementCsv(csv);
  let imported = 0;
  let skipped = 0;
  let matched = 0;
  const entries: any[] = [];
  for (const row of rows) {
    const type = row.amount >= 0 ? "CREDIT" : "DEBIT";
    const match = type === "CREDIT" ? await matchBooking(prisma, { description: row.description, reference: row.reference, amount: row.amount, date: row.date }) : { bookingId: null, confidence: null };
    try {
      const entry = await (prisma as any).bankStatementEntry.upsert({
        where: { fingerprint: row.fingerprint },
        update: {
          matchedBookingId: match.bookingId,
          matchedConfidence: match.confidence,
        },
        create: {
          source,
          bankAccount: row.bankAccount || null,
          transactionDate: row.date,
          description: row.description || row.reference || "Bank transaction",
          reference: row.reference || null,
          amount: row.amount,
          currency: row.currency || "GBP",
          type,
          matchedBookingId: match.bookingId,
          matchedConfidence: match.confidence,
          fingerprint: row.fingerprint,
          raw: row.raw,
        },
      });
      imported += 1;
      if (match.bookingId) matched += 1;
      entries.push(entry);
    } catch {
      skipped += 1;
    }
  }
  return { imported, skipped, matched, total: rows.length, entries };
}

export async function listBankStatementEntries(prisma: PrismaLike, start: Date, end: Date) {
  return (prisma as any).bankStatementEntry.findMany({
    where: { transactionDate: { gte: start, lt: end } },
    orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}
