import { describe, expect, it } from "vitest";

import { sanitizeTelemetry } from "./sanitize";

describe("sanitizeTelemetry", () => {
  it("redacts nested credentials, HR values, share codes, and raw file content", () => {
    expect(
      sanitizeTelemetry({
        password: "open-sesame",
        nested: {
          authorization: "Bearer abc.def.ghi",
          salary: 12345,
          share_code: "full-code",
          fileContent: "raw drawing"
        }
      })
    ).toEqual({
      password: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        salary: "[REDACTED]",
        share_code: "[REDACTED]",
        fileContent: "[REDACTED]"
      }
    });
  });

  it("redacts credential patterns even when the field name is harmless", () => {
    const value = sanitizeTelemetry({
      message:
        "failed with Bearer abc123, eyJaaa.bbb.ccc and postgresql://user:password@db/apm?token=secret"
    });
    expect(value).toEqual({
      message:
        "failed with Bearer [REDACTED], [REDACTED] and postgresql://[REDACTED]@db/apm?token=[REDACTED]"
    });
  });
});
