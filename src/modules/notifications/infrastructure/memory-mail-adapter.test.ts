import { describe, expect, it } from "vitest";

import { MemoryMailAdapter } from "./memory-mail-adapter";

describe("MemoryMailAdapter", () => {
  it("deduplicates the same external effect and rejects payload conflicts", async () => {
    const adapter = new MemoryMailAdapter();
    const message = {
      to: "user@example.com",
      subject: "Subject",
      text: "Body",
      html: null,
      idempotencyKey: "event:user:email"
    };
    const first = await adapter.send(message);
    const repeated = await adapter.send(message);
    expect(repeated).toEqual(first);
    expect(adapter.sentCount).toBe(1);
    await expect(adapter.send({ ...message, text: "Changed" })).rejects.toThrow("不同负载");
  });
});
