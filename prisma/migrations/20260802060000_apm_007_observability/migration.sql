-- APM-007 persists trace correlation from transactional events into durable jobs.
ALTER TABLE "outbox_events" ADD COLUMN "trace_id" TEXT;
ALTER TABLE "persistent_jobs" ADD COLUMN "trace_id" TEXT;

ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_trace_id_check"
    CHECK ("trace_id" IS NULL OR "trace_id" ~ '^[0-9a-f]{32}$');
ALTER TABLE "persistent_jobs" ADD CONSTRAINT "persistent_jobs_trace_id_check"
    CHECK ("trace_id" IS NULL OR "trace_id" ~ '^[0-9a-f]{32}$');

CREATE INDEX "outbox_events_trace_id_occurred_at_idx"
    ON "outbox_events"("trace_id", "occurred_at");
CREATE INDEX "persistent_jobs_trace_id_created_at_idx"
    ON "persistent_jobs"("trace_id", "created_at");

CREATE OR REPLACE FUNCTION enforce_outbox_event_immutability() RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
       OR NEW."aggregate_type" IS DISTINCT FROM OLD."aggregate_type"
       OR NEW."aggregate_id" IS DISTINCT FROM OLD."aggregate_id"
       OR NEW."payload" IS DISTINCT FROM OLD."payload"
       OR NEW."payload_hash" IS DISTINCT FROM OLD."payload_hash"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."trace_id" IS DISTINCT FROM OLD."trace_id"
       OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
       OR (OLD."dispatched_at" IS NOT NULL AND NEW."dispatched_at" IS DISTINCT FROM OLD."dispatched_at")
    THEN
        RAISE EXCEPTION 'outbox event facts are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_persistent_job_trace_immutability() RETURNS trigger AS $$
BEGIN
    IF NEW."trace_id" IS DISTINCT FROM OLD."trace_id" THEN
        RAISE EXCEPTION 'persistent job trace is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER persistent_jobs_enforce_trace_immutability
    BEFORE UPDATE ON "persistent_jobs"
    FOR EACH ROW EXECUTE FUNCTION enforce_persistent_job_trace_immutability();
