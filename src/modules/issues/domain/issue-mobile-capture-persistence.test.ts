import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("APM-072 mobile issue capture persistence", () => {
  it("keeps voice or text capture separate from the formal Issue fact", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const migration = readFileSync(
      "prisma/migrations/20260822010000_apm_072_mobile_issue_capture/migration.sql",
      "utf8"
    );

    expect(schema).toContain("model IssueCapture {");
    expect(schema).toContain("inputText       String?");
    expect(schema).toContain("voiceFileId     String?");
    expect(schema).toContain("issueId         String?");
    expect(schema).toContain("status          IssueCaptureStatus");
    expect(schema).toContain("@@unique([id, projectId])");
    expect(schema).not.toContain("asrTranscript");
    expect(schema).not.toContain("aiSummary");
    expect(migration).toContain('CREATE TABLE "issue_captures"');
    expect(migration).toContain('CREATE TABLE "issue_capture_attachments"');
    expect(migration).toContain('FOREIGN KEY ("voice_file_id", "project_id")');
    expect(migration).toContain('REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT');
    expect(migration).toContain('"input_text" IS NOT NULL OR "voice_file_id" IS NOT NULL');
    expect(migration).toContain("issue capture must start pending at version 1");
    expect(migration).toContain("NEW.\"created_at\" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';");
    expect(migration).toContain("file_status <> 'AVAILABLE'");
    expect(migration).toContain("file_mime NOT LIKE 'audio/%'");
    expect(migration).toContain('NEW."version" <> OLD."version" + 1');
    expect(migration).toContain('BEFORE TRUNCATE ON "issue_captures"');
    expect(migration).toContain('BEFORE TRUNCATE ON "issue_capture_attachments"');
    expect(migration).toContain('FROM "issues"');
    expect(migration).toContain("issue_source_type <> 'PROJECT'");
    expect(migration).toContain(
      "issue_phenomenon_description IS DISTINCT FROM issue_confirmed_text"
    );
  });
});
