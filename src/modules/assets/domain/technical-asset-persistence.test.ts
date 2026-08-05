import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-061 technical asset persistence", () => {
  it("seeds the technical asset maintainer role with required timestamps", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260805070000_apm_061_technical_assets/migration.sql"
      ),
      "utf8"
    );

    expect(migration).toContain(
      'INSERT INTO "roles" ("id", "code", "name", "description", "is_system", "created_at", "updated_at") VALUES'
    );
    expect(migration).toContain(
      "'role-technical-asset-maintainer', 'TECHNICAL_ASSET_MAINTAINER', '技术资产维护人', '维护企业技术资产主记录和独立验证流程', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP"
    );
  });
});
