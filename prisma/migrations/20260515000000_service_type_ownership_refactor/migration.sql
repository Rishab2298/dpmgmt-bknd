-- ─── Step 1: Create new enum types ───────────────────────────────────────────

CREATE TYPE "VehicleType_new" AS ENUM (
  'STANDARD_PARCEL_ELECTRIC_RIVIAN_MEDIUM',
  'STANDARD_PARCEL_EXTRA_LARGE_VAN',
  'STANDARD_PARCEL_CDV_14FT',
  'STANDARD_PARCEL_CDV_12FT'
);

CREATE TYPE "OwnershipType_new" AS ENUM (
  'AMAZON_RENTAL',
  'AMAZON_OWNED',
  'LEASE',
  'RENTAL'
);

-- ─── Step 2: Alter Vehicle table ──────────────────────────────────────────────

-- Drop old default on vehicleType if any, set column nullable temporarily
ALTER TABLE "Vehicle" ALTER COLUMN "vehicleType" DROP DEFAULT;
ALTER TABLE "Vehicle" ALTER COLUMN "ownershipType" DROP DEFAULT;

-- Rename vehicleType → serviceType, cast to new enum (old values default to first value)
ALTER TABLE "Vehicle"
  ALTER COLUMN "vehicleType" TYPE "VehicleType_new"
  USING 'STANDARD_PARCEL_EXTRA_LARGE_VAN'::"VehicleType_new";

ALTER TABLE "Vehicle"
  RENAME COLUMN "vehicleType" TO "serviceType";

-- Cast ownershipType to new enum (LEASED/RENTED/OWNED → LEASE/RENTAL/AMAZON_OWNED)
ALTER TABLE "Vehicle"
  ALTER COLUMN "ownershipType" TYPE "OwnershipType_new"
  USING CASE "ownershipType"::text
    WHEN 'LEASED' THEN 'LEASE'
    WHEN 'RENTED' THEN 'RENTAL'
    WHEN 'OWNED'  THEN 'AMAZON_OWNED'
    ELSE 'AMAZON_RENTAL'
  END::"OwnershipType_new";

-- ─── Step 3: Alter VehicleGroupType table ─────────────────────────────────────

-- Clear existing rows — old service type values are invalid under the new enum.
-- Vehicle groups will need to be reconfigured after this migration.
TRUNCATE TABLE "VehicleGroupType";

-- Drop the old composite PK
ALTER TABLE "VehicleGroupType" DROP CONSTRAINT "VehicleGroupType_pkey";

ALTER TABLE "VehicleGroupType"
  ALTER COLUMN "vehicleType" TYPE "VehicleType_new"
  USING 'STANDARD_PARCEL_EXTRA_LARGE_VAN'::"VehicleType_new";

ALTER TABLE "VehicleGroupType"
  RENAME COLUMN "vehicleType" TO "serviceType";

ALTER TABLE "VehicleGroupType"
  ADD CONSTRAINT "VehicleGroupType_pkey" PRIMARY KEY ("vehicleGroupId", "serviceType");

-- ─── Step 4: Drop old enum types and rename new ones ──────────────────────────

DROP TYPE "VehicleType";
ALTER TYPE "VehicleType_new" RENAME TO "VehicleType";

DROP TYPE "OwnershipType";
ALTER TYPE "OwnershipType_new" RENAME TO "OwnershipType";
