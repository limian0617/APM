-- APM-091B: the immutable readiness publication audit action.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCUREMENT_READINESS_CALCULATED';
