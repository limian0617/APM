-- APM-053 Task 4: explicit audit vocabulary for supplier manufacturing capability changes.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUPPLIER_MANUFACTURING_CAPABILITY_UPDATED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'SUPPLIER_MANUFACTURING_CAPABILITY';
