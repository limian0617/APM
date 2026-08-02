import { createHash } from "node:crypto";

import nodemailer, { type Transporter } from "nodemailer";

import type { MailAdapter, MailMessage } from "../contracts/mail";

export class NodemailerAdapter implements MailAdapter {
  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
    private readonly messageIdDomain: string
  ) {}

  async send(message: MailMessage): Promise<{ providerMessageId: string }> {
    const stableId = createHash("sha256").update(message.idempotencyKey).digest("hex");
    const result = await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      messageId: `<${stableId}@${this.messageIdDomain}>`,
      headers: { "X-APM-Idempotency-Key": stableId }
    });
    if (!result.messageId) throw new Error("SMTP 未返回 message id。");
    return { providerMessageId: result.messageId };
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少邮件环境变量 ${name}。`);
  return value;
}

function smtpPort(): number {
  const value = Number(process.env.SMTP_PORT || "587");
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error("SMTP_PORT 必须是有效端口。");
  }
  return value;
}

export function createMailAdapterFromEnvironment(): NodemailerAdapter {
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  if ((user && !password) || (!user && password)) {
    throw new Error("SMTP_USER 和 SMTP_PASSWORD 必须同时配置。");
  }
  const transporter = nodemailer.createTransport({
    host: requiredEnvironment("SMTP_HOST"),
    port: smtpPort(),
    secure: process.env.SMTP_SECURE === "true",
    ...(user && password ? { auth: { user, pass: password } } : {})
  });
  return new NodemailerAdapter(
    transporter,
    requiredEnvironment("SMTP_FROM"),
    process.env.SMTP_MESSAGE_ID_DOMAIN?.trim() || "apm.local"
  );
}
