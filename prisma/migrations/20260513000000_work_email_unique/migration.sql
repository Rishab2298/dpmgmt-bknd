-- Add unique constraint on Employee.workEmail
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_workEmail_key" ON "Employee"("workEmail");
