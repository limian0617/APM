-- APM-051 controlled-document reviews, business relations, and immutable Gate evidence.
CREATE TYPE "DocumentReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED');
CREATE TYPE "DocumentReviewEventType" AS ENUM ('REQUESTED', 'APPROVED', 'CHANGES_REQUESTED');
CREATE TYPE "DocumentVersionRelationStatus" AS ENUM ('ACTIVE', 'VOIDED');
CREATE TYPE "DocumentVersionRelationTargetType" AS ENUM (
  'DELIVERY_UNIT', 'MODULE', 'RESPONSIBILITY_PACKAGE', 'PLANNING_TASK', 'MILESTONE', 'GATE_INSTANCE'
);

ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_REVIEW_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_REVIEW_DECIDED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_REVIEW_COMMENTED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_REVIEW_COMMENT_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_VERSION_RELATED';
ALTER TYPE "AuditAction" ADD VALUE 'DOCUMENT_VERSION_RELATION_VOIDED';
ALTER TYPE "AuditObjectType" ADD VALUE 'DOCUMENT_REVIEW';
ALTER TYPE "AuditObjectType" ADD VALUE 'DOCUMENT_REVIEW_COMMENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'DOCUMENT_VERSION_RELATION';
ALTER TYPE "AuditObjectType" ADD VALUE 'GATE_SUBMISSION_DOCUMENT_REFERENCE';

CREATE TABLE "document_reviews" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "document_version_id" TEXT NOT NULL,
  "reviewer_id" TEXT NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "status" "DocumentReviewStatus" NOT NULL DEFAULT 'PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "requested_by_id" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by_id" TEXT,
  "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_reviews_version_check" CHECK ("version" > 0),
  CONSTRAINT "document_reviews_lifecycle_check" CHECK (
    ("status" = 'PENDING' AND "decided_by_id" IS NULL AND "decided_at" IS NULL)
    OR ("status" IN ('APPROVED', 'CHANGES_REQUESTED') AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)
  )
);

CREATE TABLE "document_review_events" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "review_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "DocumentReviewEventType" NOT NULL,
  "from_status" "DocumentReviewStatus",
  "to_status" "DocumentReviewStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_review_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_review_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "document_review_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024)
);

CREATE TABLE "document_review_comments" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "document_version_id" TEXT NOT NULL,
  "review_id" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_review_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_review_comments_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 4096)
);

CREATE TABLE "document_review_comment_resolutions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "comment_id" TEXT NOT NULL,
  "review_id" TEXT NOT NULL,
  "resolution" TEXT NOT NULL,
  "resolved_by_id" TEXT NOT NULL,
  "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_review_comment_resolutions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_review_comment_resolutions_resolution_check" CHECK (length(btrim("resolution")) BETWEEN 1 AND 1024)
);

CREATE TABLE "document_version_relations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "document_version_id" TEXT NOT NULL,
  "target_type" "DocumentVersionRelationTargetType" NOT NULL,
  "target_id" TEXT NOT NULL,
  "status" "DocumentVersionRelationStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voided_by_id" TEXT,
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT,
  CONSTRAINT "document_version_relations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_version_relations_target_id_check" CHECK (length(btrim("target_id")) BETWEEN 1 AND 191),
  CONSTRAINT "document_version_relations_version_check" CHECK ("version" > 0),
  CONSTRAINT "document_version_relations_lifecycle_check" CHECK (
    ("status" = 'ACTIVE' AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status" = 'VOIDED' AND "voided_by_id" IS NOT NULL AND "voided_at" IS NOT NULL AND length(btrim("void_reason")) BETWEEN 1 AND 1024)
  )
);

CREATE TABLE "gate_submission_document_references" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_submission_id" TEXT NOT NULL,
  "document_version_id" TEXT NOT NULL,
  "document_version_relation_id" TEXT NOT NULL,
  "document_code" TEXT NOT NULL,
  "document_title" TEXT NOT NULL,
  "document_version" INTEGER NOT NULL,
  "source_file_sha256" TEXT NOT NULL,
  "review_evidence_json" JSONB NOT NULL,
  "review_evidence_checksum" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_submission_document_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_submission_document_references_version_check" CHECK ("document_version" > 0),
  CONSTRAINT "gate_submission_document_references_code_check" CHECK ("document_code" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  CONSTRAINT "gate_submission_document_references_title_check" CHECK (length(btrim("document_title")) BETWEEN 1 AND 256),
  CONSTRAINT "gate_submission_document_references_sha256_check" CHECK ("source_file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "gate_submission_document_references_review_checksum_check" CHECK ("review_evidence_checksum" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "document_reviews_id_project_id_key" ON "document_reviews"("id", "project_id");
CREATE UNIQUE INDEX "document_reviews_document_version_reviewer_key" ON "document_reviews"("document_version_id", "reviewer_id");
CREATE INDEX "document_reviews_project_document_version_status_idx" ON "document_reviews"("project_id", "document_version_id", "status");
CREATE INDEX "document_reviews_reviewer_status_requested_at_idx" ON "document_reviews"("reviewer_id", "status", "requested_at");
CREATE UNIQUE INDEX "document_review_events_review_sequence_key" ON "document_review_events"("review_id", "sequence");
CREATE INDEX "document_review_events_project_created_at_idx" ON "document_review_events"("project_id", "created_at");
CREATE UNIQUE INDEX "document_review_comments_id_project_id_key" ON "document_review_comments"("id", "project_id");
CREATE INDEX "document_review_comments_review_required_created_at_idx" ON "document_review_comments"("review_id", "required", "created_at");
CREATE INDEX "document_review_comments_document_version_created_at_idx" ON "document_review_comments"("document_version_id", "created_at");
CREATE UNIQUE INDEX "document_review_comment_resolutions_comment_id_key" ON "document_review_comment_resolutions"("comment_id");
CREATE UNIQUE INDEX "document_review_comment_resolutions_comment_project_key" ON "document_review_comment_resolutions"("comment_id", "project_id");
CREATE INDEX "document_review_comment_resolutions_review_resolved_at_idx" ON "document_review_comment_resolutions"("review_id", "resolved_at");
CREATE UNIQUE INDEX "document_version_relations_id_project_id_key" ON "document_version_relations"("id", "project_id");
CREATE UNIQUE INDEX "document_version_relations_active_target_key" ON "document_version_relations"("document_version_id", "target_type", "target_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "document_version_relations_project_target_status_idx" ON "document_version_relations"("project_id", "target_type", "target_id", "status");
CREATE INDEX "document_version_relations_document_version_status_idx" ON "document_version_relations"("document_version_id", "status");
CREATE UNIQUE INDEX "gate_submission_document_references_submission_version_key" ON "gate_submission_document_references"("gate_submission_id", "document_version_id");
CREATE INDEX "gate_submission_document_references_project_version_created_at_idx" ON "gate_submission_document_references"("project_id", "document_version_id", "created_at");

ALTER TABLE "document_reviews"
  ADD CONSTRAINT "document_reviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_reviews_document_version_project_fkey" FOREIGN KEY ("document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_reviews_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_reviews_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_review_events"
  ADD CONSTRAINT "document_review_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_events_review_project_fkey" FOREIGN KEY ("review_id", "project_id") REFERENCES "document_reviews"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_review_comments"
  ADD CONSTRAINT "document_review_comments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_comments_document_version_project_fkey" FOREIGN KEY ("document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_comments_review_project_fkey" FOREIGN KEY ("review_id", "project_id") REFERENCES "document_reviews"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_comments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_review_comment_resolutions"
  ADD CONSTRAINT "document_review_comment_resolutions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_comment_resolutions_comment_project_fkey" FOREIGN KEY ("comment_id", "project_id") REFERENCES "document_review_comments"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_comment_resolutions_review_project_fkey" FOREIGN KEY ("review_id", "project_id") REFERENCES "document_reviews"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_review_comment_resolutions_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_version_relations"
  ADD CONSTRAINT "document_version_relations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_version_relations_document_version_project_fkey" FOREIGN KEY ("document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_version_relations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "document_version_relations_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_submission_document_references"
  ADD CONSTRAINT "gate_submission_document_references_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submission_document_references_submission_project_fkey" FOREIGN KEY ("gate_submission_id", "project_id") REFERENCES "gate_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submission_document_references_document_version_project_fkey" FOREIGN KEY ("document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submission_document_references_relation_project_fkey" FOREIGN KEY ("document_version_relation_id", "project_id") REFERENCES "document_version_relations"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_document_review_insert() RETURNS trigger AS $$
DECLARE
  document_status "ControlledDocumentVersionStatus";
BEGIN
  SELECT "status" INTO document_status FROM "controlled_document_versions"
    WHERE "id" = NEW."document_version_id" AND "project_id" = NEW."project_id";
  IF document_status IS DISTINCT FROM 'DRAFT'::"ControlledDocumentVersionStatus" THEN
    RAISE EXCEPTION 'document reviews require a draft document version' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "project_members" membership
    JOIN "users" reviewer ON reviewer."id" = membership."user_id" AND reviewer."status" = 'ACTIVE'
    WHERE membership."project_id" = NEW."project_id"
      AND membership."user_id" = NEW."reviewer_id" AND membership."left_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'document reviewer must be an active project member' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_document_review_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document reviews are append-only; retain their decision history' USING ERRCODE = '55000';
  END IF;
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."document_version_id" IS DISTINCT FROM OLD."document_version_id"
    OR NEW."reviewer_id" IS DISTINCT FROM OLD."reviewer_id"
    OR NEW."required" IS DISTINCT FROM OLD."required"
    OR NEW."requested_by_id" IS DISTINCT FROM OLD."requested_by_id"
    OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'document review identity and request facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'APPROVED' THEN
    RAISE EXCEPTION 'approved document reviews are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 OR NEW."status" = OLD."status"
    OR NEW."status" NOT IN ('APPROVED', 'CHANGES_REQUESTED')
    OR NEW."decided_by_id" IS NULL OR NEW."decided_at" IS NULL THEN
    RAISE EXCEPTION 'document review decisions must be an explicit lifecycle transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_document_review_comment_insert() RETURNS trigger AS $$
DECLARE
  reviewer_id TEXT;
  review_version_id TEXT;
  review_status "DocumentReviewStatus";
  document_status "ControlledDocumentVersionStatus";
BEGIN
  SELECT review."reviewer_id", review."document_version_id", review."status", document_version."status"
    INTO reviewer_id, review_version_id, review_status, document_status
    FROM "document_reviews" review
    JOIN "controlled_document_versions" document_version ON document_version."id" = review."document_version_id"
    WHERE review."id" = NEW."review_id" AND review."project_id" = NEW."project_id";
  IF reviewer_id IS NULL OR reviewer_id <> NEW."created_by_id" OR review_version_id <> NEW."document_version_id"
    OR review_status = 'APPROVED' OR document_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only the assigned reviewer may comment on an unapproved draft review' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_document_review_comment_resolution_insert() RETURNS trigger AS $$
DECLARE
  reviewer_id TEXT;
  comment_review_id TEXT;
BEGIN
  SELECT review."reviewer_id", comment."review_id" INTO reviewer_id, comment_review_id
    FROM "document_review_comments" comment
    JOIN "document_reviews" review ON review."id" = comment."review_id" AND review."project_id" = comment."project_id"
    WHERE comment."id" = NEW."comment_id" AND comment."project_id" = NEW."project_id";
  IF reviewer_id IS NULL OR reviewer_id <> NEW."resolved_by_id" OR comment_review_id <> NEW."review_id" THEN
    RAISE EXCEPTION 'only the assigned reviewer may resolve document review feedback' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_document_version_relation_target() RETURNS trigger AS $$
DECLARE
  target_exists BOOLEAN;
  document_status "ControlledDocumentVersionStatus";
BEGIN
  SELECT "status" INTO document_status FROM "controlled_document_versions"
    WHERE "id" = NEW."document_version_id" AND "project_id" = NEW."project_id";
  IF document_status NOT IN ('DRAFT', 'PUBLISHED') THEN
    RAISE EXCEPTION 'document relations require a draft or published document version' USING ERRCODE = '23514';
  END IF;
  CASE NEW."target_type"
    WHEN 'DELIVERY_UNIT' THEN SELECT EXISTS(SELECT 1 FROM "delivery_units" WHERE "id" = NEW."target_id" AND "project_id" = NEW."project_id") INTO target_exists;
    WHEN 'MODULE' THEN SELECT EXISTS(SELECT 1 FROM "project_modules" WHERE "id" = NEW."target_id" AND "project_id" = NEW."project_id") INTO target_exists;
    WHEN 'RESPONSIBILITY_PACKAGE' THEN SELECT EXISTS(SELECT 1 FROM "responsibility_packages" WHERE "id" = NEW."target_id" AND "project_id" = NEW."project_id") INTO target_exists;
    WHEN 'PLANNING_TASK' THEN SELECT EXISTS(SELECT 1 FROM "planning_tasks" WHERE "id" = NEW."target_id" AND "project_id" = NEW."project_id") INTO target_exists;
    WHEN 'MILESTONE' THEN SELECT EXISTS(SELECT 1 FROM "project_milestones" WHERE "id" = NEW."target_id" AND "project_id" = NEW."project_id") INTO target_exists;
    WHEN 'GATE_INSTANCE' THEN SELECT EXISTS(SELECT 1 FROM "project_gate_instances" WHERE "id" = NEW."target_id" AND "project_id" = NEW."project_id") INTO target_exists;
  END CASE;
  IF target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'document relation target must belong to the same project and type' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_document_version_relation_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document version relations cannot be deleted; void them instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."document_version_id" IS DISTINCT FROM OLD."document_version_id"
    OR NEW."target_type" IS DISTINCT FROM OLD."target_type"
    OR NEW."target_id" IS DISTINCT FROM OLD."target_id"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR OLD."status" <> 'ACTIVE' OR NEW."status" <> 'VOIDED'
    OR NEW."version" <> OLD."version" + 1
    OR NEW."voided_by_id" IS NULL OR NEW."voided_at" IS NULL OR length(btrim(NEW."void_reason")) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'document version relation may only transition once from active to voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_gate_submission_document_reference_insert() RETURNS trigger AS $$
DECLARE
  expected_gate_instance_id TEXT;
  relation_target_type "DocumentVersionRelationTargetType";
  relation_target_id TEXT;
  relation_status "DocumentVersionRelationStatus";
  actual_code TEXT;
  actual_title TEXT;
  actual_version INTEGER;
  actual_hash TEXT;
  actual_status "ControlledDocumentVersionStatus";
BEGIN
  SELECT "gate_instance_id" INTO expected_gate_instance_id FROM "gate_submissions"
    WHERE "id" = NEW."gate_submission_id" AND "project_id" = NEW."project_id";
  SELECT relation."target_type", relation."target_id", relation."status" INTO relation_target_type, relation_target_id, relation_status
    FROM "document_version_relations" relation
    WHERE relation."id" = NEW."document_version_relation_id" AND relation."project_id" = NEW."project_id"
      AND relation."document_version_id" = NEW."document_version_id";
  SELECT document."code", document."title", version."version", version."source_file_sha256", version."status"
    INTO actual_code, actual_title, actual_version, actual_hash, actual_status
    FROM "controlled_document_versions" version
    JOIN "controlled_documents" document ON document."id" = version."document_id" AND document."project_id" = version."project_id"
    WHERE version."id" = NEW."document_version_id" AND version."project_id" = NEW."project_id";
  IF expected_gate_instance_id IS NULL OR relation_target_type <> 'GATE_INSTANCE'
    OR relation_target_id <> expected_gate_instance_id OR relation_status <> 'ACTIVE'
    OR actual_status <> 'PUBLISHED'
    OR NEW."document_code" IS DISTINCT FROM actual_code
    OR NEW."document_title" IS DISTINCT FROM actual_title
    OR NEW."document_version" IS DISTINCT FROM actual_version
    OR NEW."source_file_sha256" IS DISTINCT FROM actual_hash THEN
    RAISE EXCEPTION 'Gate document evidence must snapshot an active exact published Gate relation' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "document_reviews" review
    WHERE review."project_id" = NEW."project_id" AND review."document_version_id" = NEW."document_version_id"
      AND review."required" = true AND review."status" <> 'APPROVED'
  ) OR EXISTS (
    SELECT 1 FROM "document_review_comments" comment
    LEFT JOIN "document_review_comment_resolutions" resolution ON resolution."comment_id" = comment."id"
    WHERE comment."project_id" = NEW."project_id" AND comment."document_version_id" = NEW."document_version_id"
      AND comment."required" = true AND resolution."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'unresolved required document review feedback blocks Gate evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_document_review_fact_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'document review facts cannot be truncated' USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'document review facts are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_gate_submission_document_reference_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Gate document evidence cannot be truncated' USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'Gate document evidence is immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_gate_submission_document_reference_set() RETURNS trigger AS $$
DECLARE
  gate_id TEXT;
  active_relation_count INTEGER;
  reference_count INTEGER;
BEGIN
  SELECT "gate_instance_id" INTO gate_id FROM "gate_submissions"
    WHERE "id" = NEW."id" AND "project_id" = NEW."project_id";
  SELECT count(*) INTO active_relation_count FROM "document_version_relations"
    WHERE "project_id" = NEW."project_id" AND "target_type" = 'GATE_INSTANCE'
      AND "target_id" = gate_id AND "status" = 'ACTIVE';
  SELECT count(*) INTO reference_count FROM "gate_submission_document_references"
    WHERE "gate_submission_id" = NEW."id" AND "project_id" = NEW."project_id";
  IF active_relation_count <> reference_count THEN
    RAISE EXCEPTION 'Gate submission must retain evidence for every active exact document relation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_reviews_validate_insert BEFORE INSERT ON "document_reviews"
  FOR EACH ROW EXECUTE FUNCTION validate_document_review_insert();
CREATE TRIGGER document_reviews_validate_mutation BEFORE UPDATE OR DELETE ON "document_reviews"
  FOR EACH ROW EXECUTE FUNCTION validate_document_review_mutation();
CREATE TRIGGER document_reviews_reject_truncate BEFORE TRUNCATE ON "document_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER document_review_events_reject_mutation BEFORE UPDATE OR DELETE ON "document_review_events"
  FOR EACH ROW EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER document_review_events_reject_truncate BEFORE TRUNCATE ON "document_review_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER document_review_comments_validate_insert BEFORE INSERT ON "document_review_comments"
  FOR EACH ROW EXECUTE FUNCTION validate_document_review_comment_insert();
CREATE TRIGGER document_review_comments_reject_mutation BEFORE UPDATE OR DELETE ON "document_review_comments"
  FOR EACH ROW EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER document_review_comments_reject_truncate BEFORE TRUNCATE ON "document_review_comments"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER document_review_comment_resolutions_validate_insert BEFORE INSERT ON "document_review_comment_resolutions"
  FOR EACH ROW EXECUTE FUNCTION validate_document_review_comment_resolution_insert();
CREATE TRIGGER document_review_comment_resolutions_reject_mutation BEFORE UPDATE OR DELETE ON "document_review_comment_resolutions"
  FOR EACH ROW EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER document_review_comment_resolutions_reject_truncate BEFORE TRUNCATE ON "document_review_comment_resolutions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER document_version_relations_validate_target BEFORE INSERT ON "document_version_relations"
  FOR EACH ROW EXECUTE FUNCTION validate_document_version_relation_target();
CREATE TRIGGER document_version_relations_validate_mutation BEFORE UPDATE OR DELETE ON "document_version_relations"
  FOR EACH ROW EXECUTE FUNCTION validate_document_version_relation_mutation();
CREATE TRIGGER document_version_relations_reject_truncate BEFORE TRUNCATE ON "document_version_relations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_document_review_fact_mutation();
CREATE TRIGGER gate_submission_document_references_validate_insert BEFORE INSERT ON "gate_submission_document_references"
  FOR EACH ROW EXECUTE FUNCTION validate_gate_submission_document_reference_insert();
CREATE TRIGGER gate_submission_document_references_reject_mutation BEFORE UPDATE OR DELETE ON "gate_submission_document_references"
  FOR EACH ROW EXECUTE FUNCTION reject_gate_submission_document_reference_mutation();
CREATE TRIGGER gate_submission_document_references_reject_truncate BEFORE TRUNCATE ON "gate_submission_document_references"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_document_reference_mutation();
CREATE CONSTRAINT TRIGGER gate_submissions_document_reference_set_check
  AFTER INSERT ON "gate_submissions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_gate_submission_document_reference_set();
