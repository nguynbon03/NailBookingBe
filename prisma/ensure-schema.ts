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
      "createdBySource" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "StaffAvailability" ADD COLUMN IF NOT EXISTS "createdBySource" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "StaffLeaveRequest" (
      "id" TEXT PRIMARY KEY,
      "staffId" TEXT NOT NULL,
      "startDate" TIMESTAMP(3) NOT NULL,
      "endDate" TIMESTAMP(3) NOT NULL,
      "daysCount" INTEGER NOT NULL,
      "reason" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "managerNote" TEXT,
      "reviewedBy" TEXT,
      "reviewedAt" TIMESTAMP(3),
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
      "entityType" TEXT,
      "entityId" TEXT,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "read" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "entityType" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "entityId" TEXT;
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
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentConfirmedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentConfirmedBy" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "staffRejectedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "staffRejectionReason" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "staffRejectionBy" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "requestedStaffId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentTransferTokenHash" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentTransferExpiresAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentTransferOpenedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentHoldStaffId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentHoldStartedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentHoldExpiresAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "paymentReference" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "sourceIp" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "depositRequired" BOOLEAN NOT NULL DEFAULT false;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "depositAmount" DECIMAL(10,2);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "depositModeSnapshot" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "numPeople" INTEGER NOT NULL DEFAULT 1;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "googleCalendarEventId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "googleCalendarSyncedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "googleCalendarLastError" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "externalProvider" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "externalBookingUid" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "externalEventTypeId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "externalLastSyncedAt" TIMESTAMP(3);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "externalSyncStatus" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "externalPayload" JSONB;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Booking_externalBookingUid_key" ON "Booking" ("externalBookingUid");
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
    CREATE INDEX IF NOT EXISTS "StaffLeaveRequest_staff_status_idx" ON "StaffLeaveRequest" ("staffId", "status");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "StaffLeaveRequest_dates_idx" ON "StaffLeaveRequest" ("startDate", "endDate");
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
    CREATE INDEX IF NOT EXISTS "Booking_payment_transfer_idx" ON "Booking" ("paymentTransferTokenHash");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Booking_payment_hold_idx" ON "Booking" ("date", "time", "paymentHoldStaffId", "paymentHoldExpiresAt");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Booking_user_status_idx" ON "Booking" ("userId", "status");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Booking_customer_email_created_idx" ON "Booking" ("customerEmail", "createdAt");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Booking_customer_phone_created_idx" ON "Booking" ("customerPhone", "createdAt");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Booking_source_ip_created_idx" ON "Booking" ("sourceIp", "createdAt");
  `);


  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BookingProtectionSetting" (
      "id" TEXT PRIMARY KEY DEFAULT 'default',
      "depositMode" TEXT NOT NULL DEFAULT 'SMART',
      "depositAmount" DECIMAL(10,2) NOT NULL DEFAULT 10.00,
      "highValueThreshold" DECIMAL(10,2) NOT NULL DEFAULT 50.00,
      "maxActiveBookingsPerCustomer" INTEGER NOT NULL DEFAULT 2,
      "maxBookingsPerPhonePerDay" INTEGER NOT NULL DEFAULT 3,
      "maxBookingsPerEmailPerDay" INTEGER NOT NULL DEFAULT 3,
      "maxBookingsPerIpPerDay" INTEGER NOT NULL DEFAULT 8,
      "requireDepositForNewCustomer" BOOLEAN NOT NULL DEFAULT true,
      "requireDepositForWeekend" BOOLEAN NOT NULL DEFAULT true,
      "requireDepositForHighValue" BOOLEAN NOT NULL DEFAULT true,
      "customerExportEnabled" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "BookingProtectionSetting" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "BookingProtectionSetting" ADD COLUMN IF NOT EXISTS "maxBookingsPerIpPerDay" INTEGER NOT NULL DEFAULT 8;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "BookingProtectionSetting" ADD COLUMN IF NOT EXISTS "customerExportEnabled" BOOLEAN NOT NULL DEFAULT true;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CustomerBlocklist" (
      "id" TEXT PRIMARY KEY,
      "type" TEXT NOT NULL,
      "value" TEXT NOT NULL,
      "reason" TEXT,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "createdBy" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "CustomerBlocklist_type_value_key" ON "CustomerBlocklist" ("type", "value");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CustomerBlocklist_active_lookup_idx" ON "CustomerBlocklist" ("active", "type", "value");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BankStatementEntry" (
      "id" TEXT PRIMARY KEY,
      "source" TEXT NOT NULL DEFAULT 'manual_statement',
      "bankAccount" TEXT,
      "transactionDate" TIMESTAMP(3) NOT NULL,
      "postedAt" TIMESTAMP(3),
      "description" TEXT NOT NULL,
      "reference" TEXT,
      "amount" DECIMAL(10,2) NOT NULL,
      "currency" TEXT NOT NULL DEFAULT 'GBP',
      "type" TEXT NOT NULL DEFAULT 'CREDIT',
      "matchedBookingId" TEXT,
      "matchedConfidence" DECIMAL(5,2),
      "fingerprint" TEXT NOT NULL,
      "raw" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "BankStatementEntry_fingerprint_key" ON "BankStatementEntry" ("fingerprint");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "BankStatementEntry_transactionDate_idx" ON "BankStatementEntry" ("transactionDate");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "BankStatementEntry_reference_idx" ON "BankStatementEntry" ("reference");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "BankStatementEntry_matchedBookingId_idx" ON "BankStatementEntry" ("matchedBookingId");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReportDeliveryLog" (
      "id" TEXT PRIMARY KEY,
      "reportType" TEXT NOT NULL,
      "period" TEXT NOT NULL,
      "periodStart" TIMESTAMP(3) NOT NULL,
      "periodEnd" TIMESTAMP(3) NOT NULL,
      "channel" TEXT NOT NULL,
      "recipient" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "provider" TEXT,
      "providerMessageId" TEXT,
      "error" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "sentAt" TIMESTAMP(3)
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "ReportDeliveryLog_report_period_channel_idx" ON "ReportDeliveryLog" ("reportType", "periodStart", "channel");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CalendarSyncSetting" (
      "id" TEXT PRIMARY KEY DEFAULT 'default',
      "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
      "googleSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
      "calcomSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
      "dailyExportEnabled" BOOLEAN NOT NULL DEFAULT true,
      "autoDailyReportEnabled" BOOLEAN NOT NULL DEFAULT false,
      "dailyReportEmailEnabled" BOOLEAN NOT NULL DEFAULT true,
      "dailyReportSmsEnabled" BOOLEAN NOT NULL DEFAULT false,
      "dailyReportIncludePdf" BOOLEAN NOT NULL DEFAULT true,
      "dailyReportTime" TEXT NOT NULL DEFAULT '08:30',
      "ownerEmail" TEXT,
      "ownerPhone" TEXT,
      "ownerCalendarId" TEXT NOT NULL DEFAULT 'primary',
      "provider" TEXT NOT NULL DEFAULT 'GOOGLE_CALENDAR',
      "lastSyncAt" TIMESTAMP(3),
      "lastExportAt" TIMESTAMP(3),
      "lastDailyReportAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "CalendarSyncSetting" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING;
  `);
  const calendarSettingColumns: Array<[string, string]> = [
    ["googleSyncEnabled", "BOOLEAN NOT NULL DEFAULT false"],
    ["calcomSyncEnabled", "BOOLEAN NOT NULL DEFAULT false"],
    ["autoDailyReportEnabled", "BOOLEAN NOT NULL DEFAULT false"],
    ["dailyReportEmailEnabled", "BOOLEAN NOT NULL DEFAULT true"],
    ["dailyReportSmsEnabled", "BOOLEAN NOT NULL DEFAULT false"],
    ["dailyReportIncludePdf", "BOOLEAN NOT NULL DEFAULT true"],
    ["dailyReportTime", "TEXT NOT NULL DEFAULT '08:30'"],
    ["ownerPhone", "TEXT"],
    ["lastDailyReportAt", "TIMESTAMP(3)"],
  ];
  for (const [column, type] of calendarSettingColumns) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "CalendarSyncSetting" ADD COLUMN IF NOT EXISTS "${column}" ${type};`);
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GoogleCalendarConnection" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "staffId" TEXT,
      "email" TEXT NOT NULL,
      "accessToken" TEXT,
      "refreshToken" TEXT,
      "scope" TEXT,
      "calendarId" TEXT NOT NULL DEFAULT 'primary',
      "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
      "lastSyncAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "GoogleCalendarConnection_userId_calendarId_key" ON "GoogleCalendarConnection" ("userId", "calendarId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "GoogleCalendarConnection_staffId_idx" ON "GoogleCalendarConnection" ("staffId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "GoogleCalendarConnection_email_idx" ON "GoogleCalendarConnection" ("email");
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CalendarSyncLog" (
      "id" TEXT PRIMARY KEY,
      "direction" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "bookingId" TEXT,
      "staffId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CalendarSyncLog_createdAt_idx" ON "CalendarSyncLog" ("createdAt");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CalendarSyncLog_bookingId_idx" ON "CalendarSyncLog" ("bookingId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CalendarSyncLog_staffId_idx" ON "CalendarSyncLog" ("staffId");
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

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StaffLeaveRequest_staffId_fkey'
      ) THEN
        ALTER TABLE "StaffLeaveRequest"
        ADD CONSTRAINT "StaffLeaveRequest_staffId_fkey"
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
