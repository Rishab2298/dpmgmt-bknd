-- CreateTable: StationVehicleType
CREATE TABLE "StationVehicleType" (
  "id"        TEXT NOT NULL,
  "stationId" TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StationVehicleType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StationVehicleType_stationId_name_key"
  ON "StationVehicleType"("stationId", "name");

ALTER TABLE "StationVehicleType"
  ADD CONSTRAINT "StationVehicleType_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Update VehicleGroupType: replace serviceType enum column with FK to StationVehicleType
TRUNCATE TABLE "VehicleGroupType";

ALTER TABLE "VehicleGroupType" DROP CONSTRAINT "VehicleGroupType_pkey";
ALTER TABLE "VehicleGroupType" DROP COLUMN "serviceType";

ALTER TABLE "VehicleGroupType" ADD COLUMN "stationVehicleTypeId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "VehicleGroupType" ALTER COLUMN "stationVehicleTypeId" DROP DEFAULT;

ALTER TABLE "VehicleGroupType"
  ADD CONSTRAINT "VehicleGroupType_pkey"
  PRIMARY KEY ("vehicleGroupId", "stationVehicleTypeId");

ALTER TABLE "VehicleGroupType"
  ADD CONSTRAINT "VehicleGroupType_stationVehicleTypeId_fkey"
  FOREIGN KEY ("stationVehicleTypeId") REFERENCES "StationVehicleType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add cascade delete to VehicleGroupType → VehicleGroup FK (was missing)
ALTER TABLE "VehicleGroupType"
  DROP CONSTRAINT IF EXISTS "VehicleGroupType_vehicleGroupId_fkey";

ALTER TABLE "VehicleGroupType"
  ADD CONSTRAINT "VehicleGroupType_vehicleGroupId_fkey"
  FOREIGN KEY ("vehicleGroupId") REFERENCES "VehicleGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
