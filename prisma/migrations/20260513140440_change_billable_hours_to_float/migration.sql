-- Replace BillableHours enum with a plain Float.
-- 0 = Flat Fee; 0.5–12.0 in half-hour steps.
-- Existing rows (if any) default to 0 (Flat Fee).

-- AlterTable: drop enum column, add float column with a temp default so NOT NULL is satisfied
ALTER TABLE "InvoiceType" DROP COLUMN "billableHours";
ALTER TABLE "InvoiceType" ADD COLUMN "billableHours" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "InvoiceType" ALTER COLUMN "billableHours" DROP DEFAULT;

-- DropEnum
DROP TYPE "BillableHours";
