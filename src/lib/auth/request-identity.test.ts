import { describe, expect, it } from "vitest";

import { readRequestIdentity } from "./request-identity";

describe("readRequestIdentity", () => {
  it("accepts the local trusted identity header outside production", () => {
    const request = new Request("http://localhost/api", {
      headers: { "x-apm-user-id": "user-1" }
    });

    expect(readRequestIdentity(request, { NODE_ENV: "development" })).toEqual({
      authenticated: true,
      userId: "user-1"
    });
  });

  it("requires the upstream trust secret in production", () => {
    const invalidRequest = new Request("https://apm.example.com/api", {
      headers: { "x-apm-user-id": "user-1", "x-apm-auth-secret": "wrong" }
    });
    const validRequest = new Request("https://apm.example.com/api", {
      headers: { "x-apm-user-id": "user-1", "x-apm-auth-secret": "expected" }
    });
    const environment = { NODE_ENV: "production", AUTH_TRUSTED_HEADER_SECRET: "expected" };

    expect(readRequestIdentity(invalidRequest, environment)).toEqual({
      authenticated: false,
      reason: "TRUST_SECRET_INVALID"
    });
    expect(readRequestIdentity(validRequest, environment)).toEqual({
      authenticated: true,
      userId: "user-1"
    });
  });
});
