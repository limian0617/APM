-- APM-101: immutable FAT/SAT failure links, Gate obligations, and residual sources.

ALTER TABLE "residual_items"
  ADD COLUMN "issue_id" TEXT,
  ADD COLUMN "acceptance_result_revision_id" TEXT;

ALTER TABLE "residual_items"
  ADD CONSTRAINT "residual_items_issue_project_id_fkey"
    FOREIGN KEY ("issue_id", "project_id")
    REFERENCES "issues"("id", "project_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "residual_items_acceptance_result_revision_project_id_fkey"
    FOREIGN KEY ("acceptance_result_revision_id", "project_id")
    REFERENCES "acceptance_test_result_revisions"("id", "project_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "residual_items_acceptance_source_pair"
    CHECK (
      ("issue_id" IS NULL AND "acceptance_result_revision_id" IS NULL)
      OR ("issue_id" IS NOT NULL AND "acceptance_result_revision_id" IS NOT NULL)
    );

CREATE INDEX "residual_items_project_issue_status_idx"
  ON "residual_items"("project_id", "issue_id", "status");

CREATE INDEX "residual_items_project_acceptance_result_revision_status_idx"
  ON "residual_items"("project_id", "acceptance_result_revision_id", "status");

CREATE UNIQUE INDEX "issue_relations_active_test_result_unique"
  ON "issue_relations"("project_id", "issue_id", "relation_type", "target_id")
  WHERE "relation_type" = 'TEST_RESULT' AND "status" = 'ACTIVE';

CREATE OR REPLACE FUNCTION "enforce_issue_test_result_relation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."relation_type" = 'TEST_RESULT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "acceptance_test_result_revisions" revision
      INNER JOIN "acceptance_test_results" result
        ON result."id" = revision."result_id"
       AND result."project_id" = revision."project_id"
      INNER JOIN "acceptance_batches" batch
        ON batch."id" = result."batch_id"
       AND batch."project_id" = result."project_id"
      WHERE revision."id" = NEW."target_id"
        AND revision."project_id" = NEW."project_id"
        AND revision."decision" = 'FAIL'
    ) THEN
      RAISE EXCEPTION 'ACCEPTANCE_FAILURE_DECISION_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "issue_relations_test_result_guard"
BEFORE INSERT OR UPDATE OF "project_id", "relation_type", "target_id"
ON "issue_relations"
FOR EACH ROW
EXECUTE FUNCTION "enforce_issue_test_result_relation"();
