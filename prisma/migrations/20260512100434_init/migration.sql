-- CreateEnum
CREATE TYPE "SuperAdminRole" AS ENUM ('OWNER', 'DEVELOPER', 'BILLING', 'ACCOUNTS', 'DSP_SUPPORT');

-- CreateEnum
CREATE TYPE "PermissionLevel" AS ENUM ('OWNER', 'OPERATIONS_ACCOUNT_MANAGER', 'OPERATIONS_MANAGER', 'DISPATCHER', 'DELIVERY_ASSOCIATE');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ONBOARDING', 'INACTIVE', 'OFFBOARDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('CARGO_VAN', 'STEP_VAN', 'CDV', 'EDV', 'XL_CARGO');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('LEASED', 'RENTED', 'OWNED');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "Dsp" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amazonDspId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dsp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "dspId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geofenceRadius" DOUBLE PRECISION,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "parkingLotAddress" TEXT,
    "parkingLotLat" DOUBLE PRECISION,
    "parkingLotLng" DOUBLE PRECISION,
    "parkingLotGeofenceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "dspId" TEXT,
    "primaryStationId" TEXT,
    "clerkUserId" TEXT,
    "legalFirstName" TEXT NOT NULL,
    "legalMiddleName" TEXT,
    "legalLastName" TEXT NOT NULL,
    "homePhone" TEXT,
    "personalMobile" TEXT,
    "workEmail" TEXT,
    "workMobile" TEXT,
    "workPhone" TEXT,
    "personalEmail" TEXT,
    "hireDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3),
    "birthDate" TIMESTAMP(3),
    "ssnLast4" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ONBOARDING',
    "permissionLevel" "PermissionLevel" NOT NULL DEFAULT 'DELIVERY_ASSOCIATE',
    "supervisorId" TEXT,
    "primaryVanId" TEXT,
    "secondaryVanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "dspId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "vin" TEXT,
    "licensePlate" TEXT,
    "year" INTEGER,
    "make" TEXT,
    "model" TEXT,
    "vehicleType" "VehicleType" NOT NULL,
    "amazonBranded" BOOLEAN NOT NULL DEFAULT false,
    "cubicFeetStorage" DOUBLE PRECISION,
    "ownershipType" "OwnershipType" NOT NULL,
    "leaseStart" TIMESTAMP(3),
    "leaseEnd" TIMESTAMP(3),
    "leaseCompany" TEXT,
    "rentalStart" TIMESTAMP(3),
    "rentalEnd" TIMESTAMP(3),
    "rentalCompany" TEXT,
    "licensePlateExpiration" TIMESTAMP(3),
    "eldUnitCode" TEXT,
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "requiredSkillId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "dspId" TEXT NOT NULL,
    "stationId" TEXT,
    "phoneNumber" TEXT,
    "deviceName" TEXT,
    "serialNumber" TEXT,
    "isPersonalDevice" BOOLEAN NOT NULL DEFAULT false,
    "canRunLoadOut" BOOLEAN NOT NULL DEFAULT false,
    "assignedEmployeeId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "dspId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSkill" (
    "employeeId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,

    CONSTRAINT "EmployeeSkill_pkey" PRIMARY KEY ("employeeId","skillId")
);

-- CreateTable
CREATE TABLE "BalanceGroup" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BalanceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftType" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "balanceGroupId" TEXT,
    "requiredSkillId" TEXT,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "startTime" TEXT,
    "endTime" TEXT,
    "breakMinutes" INTEGER,
    "notes" TEXT,
    "countAsDriver" BOOLEAN NOT NULL DEFAULT true,
    "isSystemType" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuperAdmin" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "SuperAdminRole" NOT NULL DEFAULT 'DSP_SUPPORT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuperAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dsp_amazonDspId_key" ON "Dsp"("amazonDspId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_clerkUserId_key" ON "Employee"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vin_key" ON "Vehicle"("vin");

-- CreateIndex
CREATE UNIQUE INDEX "Device_serialNumber_key" ON "Device"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_dspId_name_key" ON "Skill"("dspId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceGroup_stationId_name_key" ON "BalanceGroup"("stationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftType_stationId_name_key" ON "ShiftType"("stationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SuperAdmin_clerkUserId_key" ON "SuperAdmin"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SuperAdmin_email_key" ON "SuperAdmin"("email");

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_dspId_fkey" FOREIGN KEY ("dspId") REFERENCES "Dsp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_dspId_fkey" FOREIGN KEY ("dspId") REFERENCES "Dsp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_primaryStationId_fkey" FOREIGN KEY ("primaryStationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_primaryVanId_fkey" FOREIGN KEY ("primaryVanId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_secondaryVanId_fkey" FOREIGN KEY ("secondaryVanId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_dspId_fkey" FOREIGN KEY ("dspId") REFERENCES "Dsp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_requiredSkillId_fkey" FOREIGN KEY ("requiredSkillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_dspId_fkey" FOREIGN KEY ("dspId") REFERENCES "Dsp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_dspId_fkey" FOREIGN KEY ("dspId") REFERENCES "Dsp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSkill" ADD CONSTRAINT "EmployeeSkill_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSkill" ADD CONSTRAINT "EmployeeSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceGroup" ADD CONSTRAINT "BalanceGroup_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftType" ADD CONSTRAINT "ShiftType_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftType" ADD CONSTRAINT "ShiftType_balanceGroupId_fkey" FOREIGN KEY ("balanceGroupId") REFERENCES "BalanceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftType" ADD CONSTRAINT "ShiftType_requiredSkillId_fkey" FOREIGN KEY ("requiredSkillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
