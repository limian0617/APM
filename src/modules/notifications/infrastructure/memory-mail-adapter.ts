import { payloadHash } from "@/modules/governance/domain/idempotency";

import type { MailAdapter, MailMessage } from "../contracts/mail";

export class MemoryMailAdapter implements MailAdapter {
  private readonly messages = new Map<
    string,
    { payloadHash: string; message: MailMessage; providerMessageId: string }
  >();

  async send(message: MailMessage): Promise<{ providerMessageId: string }> {
    const canonical = payloadHash(message);
    const existing = this.messages.get(message.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== canonical.hash) {
        throw new Error("邮件幂等键已绑定到不同负载。");
      }
      return { providerMessageId: existing.providerMessageId };
    }
    const providerMessageId = `memory-${this.messages.size + 1}`;
    this.messages.set(message.idempotencyKey, {
      payloadHash: canonical.hash,
      message,
      providerMessageId
    });
    return { providerMessageId };
  }

  get sentCount(): number {
    return this.messages.size;
  }

  sentMessages(): MailMessage[] {
    return Array.from(this.messages.values(), ({ message }) => message);
  }
}
