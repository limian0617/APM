import { describe, expect, it } from "vitest";

import {
  buildAcceptancePageState,
  resolveAcceptanceFixture,
  toAcceptanceFetchResult,
  type AcceptancePageState
} from "./acceptance-page-state";

const timestamp = "2026-08-09T04:00:00.000Z";

describe("acceptance page state", () => {
  it("accepts only named fixtures in development and ignores them in production", () => {
    expect(resolveAcceptanceFixture("normal", "development")).toBe("normal");
    expect(resolveAcceptanceFixture("generating", "development")).toBe("generating");
    expect(resolveAcceptanceFixture("failed", "development")).toBe("failed");
    expect(resolveAcceptanceFixture("conflict", "development")).toBe("conflict");
    expect(resolveAcceptanceFixture("unknown", "development")).toBeNull();
    expect(resolveAcceptanceFixture("denied", "production")).toBeNull();
  });

  it("maps 401/403 from a primary source to denied without exposing its body", () => {
    const state = buildAcceptancePageState({
      projectId: "p-1",
      templates: toAcceptanceFetchResult({ status: 403, body: { secret: "do-not-expose" } }),
      batches: toAcceptanceFetchResult({ status: 200, body: { batches: [] } })
    });
    expect(state.status).toBe("denied");
    expect(JSON.stringify(state)).not.toContain("do-not-expose");
  });

  it("keeps normal, stale, and empty states distinct", () => {
    const ready = buildAcceptancePageState({
      projectId: "p-1",
      templates: toAcceptanceFetchResult({
        status: 200,
        body: { templates: [{ id: "tv-1" }] },
        fetchedAt: timestamp
      }),
      batches: toAcceptanceFetchResult({
        status: 200,
        body: { batches: [{ id: "b-1" }] },
        fetchedAt: timestamp
      })
    });
    expect(ready.status).toBe("ready");
    const stale = buildAcceptancePageState({
      projectId: "p-1",
      templates: toAcceptanceFetchResult({
        status: 200,
        body: { templates: [{ id: "tv-1" }] },
        fetchedAt: timestamp,
        stale: true
      }),
      batches: toAcceptanceFetchResult({
        status: 200,
        body: { batches: [{ id: "b-1" }] },
        fetchedAt: timestamp
      })
    });
    expect(stale.status).toBe("stale");
    const empty = buildAcceptancePageState({
      projectId: "p-1",
      templates: toAcceptanceFetchResult({ status: 200, body: { templates: [] } }),
      batches: toAcceptanceFetchResult({ status: 200, body: { batches: [] } })
    });
    expect(empty.status).toBe("empty");
  });

  it("maps retryable and non-retryable errors predictably", () => {
    const retry = buildAcceptancePageState({
      projectId: "p-1",
      templates: toAcceptanceFetchResult({ status: 503, body: { internal: "hidden" } }),
      batches: toAcceptanceFetchResult({ status: 200, body: { batches: [] } })
    });
    expect(retry).toMatchObject({ status: "error", retryable: true });
    const failed = buildAcceptancePageState({
      projectId: "p-1",
      templates: toAcceptanceFetchResult({ status: 500 }),
      batches: toAcceptanceFetchResult({ status: 200, body: { batches: [] } })
    });
    expect(failed).toMatchObject({ status: "error", retryable: false });
  });

  it("rejects cross-project batch detail and preserves per-source timestamps", () => {
    const state = buildAcceptancePageState({
      projectId: "p-1",
      templates: toAcceptanceFetchResult({
        status: 200,
        body: { templates: [] },
        fetchedAt: "2026-08-09T01:00:00.000Z"
      }),
      batches: toAcceptanceFetchResult({
        status: 200,
        body: { batches: [{ id: "b-1", projectId: "p-1" }] },
        fetchedAt: "2026-08-09T02:00:00.000Z"
      }),
      batchDetail: toAcceptanceFetchResult({
        status: 200,
        body: { batch: { id: "b-1", projectId: "p-2" } },
        fetchedAt: "2026-08-09T03:00:00.000Z"
      })
    });
    expect(state.status).toBe("error");
    expect((state as Extract<AcceptancePageState, { status: "error" }>).retryable).toBe(false);
  });
});
