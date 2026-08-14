import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-104 knowledge persistence contract", () => {
  it("declares source-frozen knowledge, composite version FKs, and bounded search storage", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
      ),
      "utf8"
    );

    for (const model of [
      "KnowledgeEntry",
      "KnowledgeEntryVersion",
      "KnowledgeEntrySource",
      "KnowledgeEntryReview",
      "KnowledgeReuseRecord",
      "KnowledgeReuseCorrection",
      "ProjectClosurePolicy",
      "ProjectClosurePolicyVersion",
      "ProjectClosureRecord"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
    for (const enumName of [
      "KnowledgeEntryStatus",
      "KnowledgeEntryVersionStatus",
      "KnowledgeReviewDecision",
      "KnowledgeReuseCorrectionType"
    ]) {
      expect(schema).toContain(`enum ${enumName}`);
    }
    for (const declaration of [
      'CREATE TABLE "knowledge_entries"',
      'CREATE TABLE "knowledge_entry_versions"',
      'CREATE TABLE "knowledge_entry_sources"',
      'CREATE TABLE "knowledge_entry_reviews"',
      'CREATE TABLE "knowledge_reuse_records"',
      'CREATE TABLE "knowledge_reuse_corrections"',
      'CREATE TABLE "project_closure_policies"',
      'CREATE TABLE "project_closure_policy_versions"',
      'CREATE TABLE "project_closure_records"',
      "knowledge_entry_reviews_version_entry_project_fkey",
      "knowledge_reuse_records_version_entry_fkey",
      "knowledge_entry_sources_archive_a_fkey",
      "knowledge_entry_versions_search_trgm_idx",
      "knowledge_entry_source_issue_tuple_check",
      "knowledge_entry_sources_issue_history_active_key",
      "knowledge_entry_versions_immutable"
    ]) {
      expect(migration).toContain(declaration);
    }
  });

  it("allows only the approved terminal revocations in the immutable-version trigger", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
      ),
      "utf8"
    );
    const functionMatch = migration.match(
      /CREATE OR REPLACE FUNCTION "validate_knowledge_entry_version_mutation"\(\)\s+RETURNS TRIGGER AS \$\$(?<body>[\s\S]*?)\$\$ LANGUAGE plpgsql;/u
    );
    const body = functionMatch?.groups?.body;

    expect(body).toBeDefined();
    expect(body).toContain(
      `OLD."status" = 'PUBLISHED' AND NEW."status" IN ('SUPERSEDED', 'REVOKED')`
    );
    expect(body).toContain(`OLD."status" = 'SUPERSEDED' AND NEW."status" = 'REVOKED'`);
    expect(body).not.toMatch(
      /OLD\."status"\s*=\s*'REVOKED'\s+AND\s+NEW\."status"\s*=\s*'PUBLISHED'/u
    );
    expect(body).not.toMatch(
      /OLD\."status"\s*=\s*'SUPERSEDED'\s+AND\s+NEW\."status"\s*=\s*'PUBLISHED'/u
    );
    expect(body).toContain(
      "RAISE EXCEPTION 'invalid knowledge version status transition' USING ERRCODE = '23514'"
    );
  });
});
