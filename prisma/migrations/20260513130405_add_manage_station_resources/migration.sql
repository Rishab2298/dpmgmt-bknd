/*
  Warnings:

  - You are about to drop the column `balanceGroupId` on the `ShiftType` table. All the data in the column will be lost.
  - You are about to drop the `BalanceGroup` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('SUBMITTED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "RateCriteria" AS ENUM ('PER_HOUR', 'PER_STOP', 'PER_PACKAGE', 'PER_ROUTE', 'PER_SHIFT', 'FLAT_RATE');

-- CreateEnum
CREATE TYPE "InvoiceCategory" AS ENUM ('DELIVERY', 'DISPATCH', 'MANAGEMENT', 'TRAINING', 'OVERTIME', 'OTHER');

-- CreateEnum
CREATE TYPE "BillableHours" AS ENUM ('REGULAR', 'OVERTIME', 'DOUBLE_TIME', 'HOLIDAY', 'SICK');

-- DropForeignKey
ALTER TABLE "BalanceGroup" DROP CONSTRAINT "BalanceGroup_stationId_fkey";

-- DropForeignKey
ALTER TABLE "ShiftType" DROP CONSTRAINT "ShiftType_balanceGroupId_fkey";

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "vehicleId" TEXT;

-- AlterTable
ALTER TABLE "ShiftType" DROP COLUMN "balanceGroupId",
ADD COLUMN     "vehicleGroupId" TEXT;

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- DropTable
DROP TABLE "BalanceGroup";

-- CreateTable
CREATE TABLE "VehicleGroup" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleGroupType" (
    "vehicleGroupId" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,

    CONSTRAINT "VehicleGroupType_pkey" PRIMARY KEY ("vehicleGroupId","vehicleType")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "dspId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "weekStartDate" TEXT NOT NULL,
    "availableDates" TEXT[],
    "notes" TEXT,
    "status" "AvailabilityStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Qualification" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateCard" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criteria" "RateCriteria" NOT NULL,
    "effectiveRate" DOUBLE PRECISION NOT NULL,
    "cumulativeRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceType" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "InvoiceCategory" NOT NULL,
    "billableHours" "BillableHours" NOT NULL,
    "rateCardId" TEXT,
    "rateSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleGroup_stationId_name_key" ON "VehicleGroup"("stationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Availability_employeeId_weekStartDate_key" ON "Availability"("employeeId", "weekStartDate");

-- CreateIndex
CREATE UNIQUE INDEX "Qualification_stationId_name_key" ON "Qualification"("stationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RateCard_stationId_name_key" ON "RateCard"("stationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceType_stationId_name_key" ON "InvoiceType"("stationId", "name");

-- AddForeignKey
ALTER TABLE "VehicleGroup" ADD CONSTRAINT "VehicleGroup_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleGroupType" ADD CONSTRAINT "VehicleGroupType_vehicleGroupId_fkey" FOREIGN KEY ("vehicleGroupId") REFERENCES "VehicleGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftType" ADD CONSTRAINT "ShiftType_vehicleGroupId_fkey" FOREIGN KEY ("vehicleGroupId") REFERENCES "VehicleGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_dspId_fkey" FOREIGN KEY ("dspId") REFERENCES "Dsp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateCard" ADD CONSTRAINT "RateCard_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceType" ADD CONSTRAINT "InvoiceType_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceType" ADD CONSTRAINT "InvoiceType_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "RateCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
