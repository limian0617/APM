-- The capability enum value is added by the preceding migration.
-- Keep this seed in a later migration so PostgreSQL can commit the new enum
-- value before it is used in a row value (SQLSTATE 55P04).
INSERT INTO "company_capabilities" ("code", "enabled", "version", "updated_at") VALUES
  ('PROCUREMENT_COLLABORATION', false, 1, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
