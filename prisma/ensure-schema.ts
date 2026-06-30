import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "StaffAvailability" (
      "id" TEXT PRIMARY KEY,
      "staffId" TEXT NOT NULL,
      "dayOfWeek" INTEGER,
      "date" TIMESTAMP(3),
      "startTime" TEXT NOT NULL,
      "endTime" TEXT NOT NULL,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Notification" (
      "id" TEXT PRIMARY KEY,
      "audience" TEXT NOT NULL,
      "userId" TEXT,
      "staffId" TEXT,
      "bookingId" TEXT,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "read" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CustomerNotification" (
      "id" TEXT PRIMARY KEY,
      "bookingId" TEXT,
      "channel" TEXT NOT NULL,
      "recipient" TEXT NOT NULL,
      "event" TEXT NOT NULL,
      "subject" TEXT,
      "message" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "provider" TEXT,
      "providerMessageId" TEXT,
      "error" TEXT,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "sentAt" TIMESTAMP(3)
    );
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "emailVerificationTokenHash" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "emailVerificationExpiresAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "emailVerificationSentAt" TIMESTAMP(3);
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerificationTokenHash" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerificationExpiresAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerificationSentAt" TIMESTAMP(3);
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "StaffAvailability_staffId_idx" ON "StaffAvailability" ("staffId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "StaffAvailability_date_day_idx" ON "StaffAvailability" ("date", "dayOfWeek");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Notification_audience_read_idx" ON "Notification" ("audience", "read");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CustomerNotification_booking_status_idx" ON "CustomerNotification" ("bookingId", "status");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Booking_email_verification_idx" ON "Booking" ("emailVerificationTokenHash");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "User_email_verification_idx" ON "User" ("emailVerificationTokenHash");
  `);

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StaffAvailability_staffId_fkey'
      ) THEN
        ALTER TABLE "StaffAvailability"
        ADD CONSTRAINT "StaffAvailability_staffId_fkey"
        FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;
  `);

  console.log("Non-destructive schema ensure complete");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
