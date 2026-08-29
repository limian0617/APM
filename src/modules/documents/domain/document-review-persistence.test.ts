import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-051 document review persistence contract", () => {
  it("retains review history and exact Gate evidence as non-truncatable facts", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260805060000_apm_051_document_reviews/migration.sql"
      ),
      "utf8"
    );

    for (const declaration of [
      "model DocumentReview",
      "model DocumentReviewEvent",
      "model DocumentReviewComment",
      "model DocumentReviewCommentResolution",
      "model DocumentVersionRelation",
      "model GateSubmissionDocumentReference"
    ]) {
      expect(schema).toContain(declaration);
    }

    for (const declaration of [
      'CREATE TABLE "document_reviews"',
      'CREATE TABLE "document_version_relations"',
      'CREATE TABLE "gate_submission_document_references"',
      "document_reviews_validate_mutation",
      "document_reviews_reject_truncate",
      "gate_submission_document_references_reject_mutation",
      "gate_submission_document_references_reject_truncate",
      "gate_submissions_document_reference_set_check"
    ]) {
      expect(migration).toContain(declaration);
    }
  });
});
