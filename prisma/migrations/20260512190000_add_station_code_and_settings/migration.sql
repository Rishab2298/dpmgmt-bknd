-- Migration: add_station_code_and_settings
-- Renames `name` → `code` (station code like "DAX1"),
-- adds optional `name` (display name), and new settings fields.

-- Step 1: Add `code` as nullable first, backfill from existing `name`, then make it required
ALTER TABLE "Station" ADD COLUMN "code" TEXT;
UPDATE "Station" SET "code" = "name";
ALTER TABLE "Station" ALTER COLUMN "code" SET NOT NULL;

-- Step 2: Make `name` optional (it was required before)
ALTER TABLE "Station" ALTER COLUMN "name" DROP NOT NULL;
-- Clear existing values so `name` starts as null (the old value is now in `code`)
UPDATE "Station" SET "name" = NULL;

-- Step 3: Add new fields
ALTER TABLE "Station" ADD COLUMN "geofenceEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Station" ADD COLUMN "parkingLotGeofenceRadius" DOUBLE PRECISION;
ALTER TABLE "Station" ADD COLUMN "enrollInDailySummaryReport" BOOLEAN NOT NULL DEFAULT false;

-- Step 4: Add unique constraint on (dspId, code)
CREATE UNIQUE INDEX "Station_dspId_code_key" ON "Station"("dspId", "code");
