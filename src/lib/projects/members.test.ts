import { describe, expect, it } from "vitest";

import { parseAddProjectMemberInput, parseIfMatchVersion, ProjectMemberError } from "./members";

describe("project member input", () => {
  it("parses a valid project member assignment", () => {
    expect(
      parseAddProjectMemberInput({
        userId: "user-2",
        projectRole: "QUALITY",
        departmentId: "quality",
        projectVersion: 4
      })
    ).toEqual({
      userId: "user-2",
      projectRole: "QUALITY",
      departmentId: "quality",
      projectVersion: 4
    });
  });

  it("rejects an unknown project role", () => {
    expect(() =>
      parseAddProjectMemberInput({
        userId: "user-2",
        projectRole: "EXECUTIVE",
        projectVersion: 1
      })
    ).toThrowError(ProjectMemberError);
  });

  it("parses strong and weak If-Match project versions", () => {
    expect(parseIfMatchVersion('"7"')).toBe(7);
    expect(parseIfMatchVersion('W/"8"')).toBe(8);
    expect(() => parseIfMatchVersion(null)).toThrowError(ProjectMemberError);
  });
});
