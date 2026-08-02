export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string | null;
  idempotencyKey: string;
};

export interface MailAdapter {
  send(message: MailMessage): Promise<{ providerMessageId: string }>;
}
