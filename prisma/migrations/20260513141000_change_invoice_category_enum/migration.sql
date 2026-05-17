-- Replace InvoiceCategory enum values.
-- Existing rows (if any) are remapped to AMZL_LATE_CANCELLATION.

-- Step 1: create the new enum
CREATE TYPE "InvoiceCategory_new" AS ENUM ('AMZL_LATE_CANCELLATION', 'DSP_LATE_CANCELLATION', 'SERVICE_TYPE');

-- Step 2: convert column, setting all existing rows to the first valid value
ALTER TABLE "InvoiceType"
  ALTER COLUMN "category" TYPE "InvoiceCategory_new"
  USING 'AMZL_LATE_CANCELLATION'::"InvoiceCategory_new";

-- Step 3: drop old enum, rename new one into place
DROP TYPE "InvoiceCategory";
ALTER TYPE "InvoiceCategory_new" RENAME TO "InvoiceCategory";
