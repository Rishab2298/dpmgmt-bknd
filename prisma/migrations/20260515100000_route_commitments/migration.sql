-- CreateTable
CREATE TABLE "RouteCommitment" (
    "id" TEXT NOT NULL,
    "dspId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "shiftTypeId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "sun" INTEGER NOT NULL DEFAULT 0,
    "mon" INTEGER NOT NULL DEFAULT 0,
    "tue" INTEGER NOT NULL DEFAULT 0,
    "wed" INTEGER NOT NULL DEFAULT 0,
    "thu" INTEGER NOT NULL DEFAULT 0,
    "fri" INTEGER NOT NULL DEFAULT 0,
    "sat" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteCommitment_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "RouteCommitment_stationId_shiftTypeId_weekStart_key" ON "RouteCommitment"("stationId", "shiftTypeId", "weekStart");

-- AddForeignKey
ALTER TABLE "RouteCommitment" ADD CONSTRAINT "RouteCommitment_dspId_fkey" FOREIGN KEY ("dspId") REFERENCES "Dsp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteCommitment" ADD CONSTRAINT "RouteCommitment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteCommitment" ADD CONSTRAINT "RouteCommitment_shiftTypeId_fkey" FOREIGN KEY ("shiftTypeId") REFERENCES "ShiftType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
