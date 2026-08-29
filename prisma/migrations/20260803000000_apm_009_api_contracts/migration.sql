-- APM-009 stores only successful API command results. A row is claimed and
-- completed inside the same transaction as the business mutation.
CREATE TABLE "api_idempotency_records" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "api_idempotency_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_idempotency_records_operation_check"
      CHECK (char_length("operation") BETWEEN 1 AND 191),
    CONSTRAINT "api_idempotency_records_key_check"
      CHECK (char_length("idempotency_key") BETWEEN 1 AND 191),
    CONSTRAINT "api_idempotency_records_request_hash_check"
      CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "api_idempotency_records_completion_check"
      CHECK (
        ("response_status" IS NULL AND "response_json" IS NULL AND "completed_at" IS NULL)
        OR
        ("response_status" BETWEEN 200 AND 299 AND "response_json" IS NOT NULL AND "completed_at" IS NOT NULL)
      )
);

CREATE UNIQUE INDEX "api_idempotency_records_actor_id_operation_idempotency_key_key"
  ON "api_idempotency_records"("actor_id", "operation", "idempotency_key");

CREATE INDEX "api_idempotency_records_completed_at_created_at_idx"
  ON "api_idempotency_records"("completed_at", "created_at");

ALTER TABLE "api_idempotency_records"
  ADD CONSTRAINT "api_idempotency_records_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_completed_api_idempotency_change() RETURNS trigger AS $$
BEGIN
  IF OLD."completed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'completed API idempotency records are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "api_idempotency_records_immutable"
  BEFORE UPDATE OR DELETE ON "api_idempotency_records"
  FOR EACH ROW EXECUTE FUNCTION prevent_completed_api_idempotency_change();
