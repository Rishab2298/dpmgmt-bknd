-- AlterTable
ALTER TABLE "ShiftType" ADD COLUMN     "invoiceTypeId" TEXT,
ADD COLUMN     "qualificationId" TEXT;

-- AddForeignKey
ALTER TABLE "ShiftType" ADD CONSTRAINT "ShiftType_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftType" ADD CONSTRAINT "ShiftType_invoiceTypeId_fkey" FOREIGN KEY ("invoiceTypeId") REFERENCES "InvoiceType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
